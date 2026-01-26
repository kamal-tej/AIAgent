import { GoogleGenerativeAI } from '@google/generative-ai';
import { OrderRequest, ItemDetails } from '../types/booking.types';

export async function parseOrderWithAI(text: string): Promise<OrderRequest> {
  try {
    // Check if API key exists (use GEMINI_API_KEY or fallback to OPENAI_API_KEY for backward compatibility)
    const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('No Gemini API key configured. Set GEMINI_API_KEY in .env file');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `You are a Zepto ordering assistant that extracts detailed grocery/item order information from natural language.
Extract item details with maximum information:
- name: Item name (e.g., "Milk", "Bread", "Rice")
- brand: Brand name if mentioned (e.g., "Amul", "Mother Dairy", "Britannia", "Tata")
- quantity: Number of items (default: 1)
- weight: Weight/volume with unit (e.g., "1kg", "500gm", "1L", "500ml")
- price: Price if mentioned (in rupees)
- unit: Unit of measurement ("kg", "gm", "L", "ml", "piece", "packet")

Also extract:
- deliveryAddress: Delivery address if mentioned
- city: City name if mentioned

Example input: "Order 2 Amul milk 1L and Britannia bread 500gm"
Example output:
{
  "items": [
    {"name": "Milk", "brand": "Amul", "quantity": 2, "weight": "1L", "unit": "L"},
    {"name": "Bread", "brand": "Britannia", "quantity": 1, "weight": "500gm", "unit": "gm"}
  ]
}

Respond ONLY with valid JSON, no other text.

User input: ${text}`;

    const result = await model.generateContent(prompt);
    let response = result.response.text();
    console.log(response);
    if (!response) throw new Error('No response from AI');

    // Remove markdown code blocks if present
    response = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const parsed = JSON.parse(response);
    
    // Validate required fields
    if (!parsed.items || parsed.items.length === 0) {
      throw new Error('Could not extract itemDetails');
    }

    return {
      items: parsed.items.map((item: any) => ({
        name: item.name,
        brand: item.brand || undefined,
        quantity: item.quantity || 1,
        weight: item.weight || undefined,
        price: item.price || undefined,
        unit: item.unit || undefined
      })),
      deliveryAddress: parsed.deliveryAddress || undefined,
      city: parsed.city || undefined
    };

  } catch (error) {
    console.error('AI parsing error:', error);
    
    // Check if it's a Gemini API error (rate limit, quota, etc.)
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (errorMessage.includes('quota') || 
        errorMessage.includes('rate limit') || 
        errorMessage.includes('429') ||
        errorMessage.includes('503') ||
        errorMessage.includes('RESOURCE_EXHAUSTED')) {
      console.log(errorMessage);
      throw new Error('🔄 Too many requests! Gemini AI is overloaded. Please try again in a few moments.');
    }
    
    if (errorMessage.includes('API key') || errorMessage.includes('401')) {
      throw new Error('❌ Gemini API key issue. Please check your configuration.');
    }
    
    // For other errors, show generic message
    throw new Error('🤖 AI service temporarily unavailable. Please try again shortly.');
  }
}

// Fallback regex-based parser
export function parseOrderWithRegex(text: string): OrderRequest {
  const lowerText = text.toLowerCase();
  
  // Extract items with brands and weights
  const itemDetails: ItemDetails[] = [];
  
  // Common items and brands
  const commonItems = ['milk', 'bread', 'eggs', 'butter', 'cheese', 'rice', 'flour', 'sugar', 'tea', 'coffee', 'oil', 'soap', 'shampoo'];
  const brands = ['amul', 'mother dairy', 'britannia', 'tata', 'nestle', 'parle', 'dabur', 'patanjali'];
  
  for (const item of commonItems) {
    if (lowerText.includes(item)) {
      const itemDetail: ItemDetails = {
        name: item.charAt(0).toUpperCase() + item.slice(1),
        quantity: 1
      };
      
      // Check for brand
      for (const brand of brands) {
        if (lowerText.includes(brand)) {
          itemDetail.brand = brand.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          break;
        }
      }
      
      // Extract weight/volume (e.g., "1kg", "500gm", "1L", "500ml")
      const weightMatch = text.match(new RegExp(`${item}[^,\\.]*?(\\d+(?:\\.\\d+)?\\s*(?:kg|gm|gram|l|liter|ml|g))`, 'i'));
      if (weightMatch) {
        itemDetail.weight = weightMatch[1].replace(/\s+/g, '');
        itemDetail.unit = itemDetail.weight.replace(/[\d.]/g, '');
      }
      
      // Extract quantity (e.g., "2 milk")
      const qtyMatch = text.match(new RegExp(`(\\d+)\\s*${item}`, 'i'));
      if (qtyMatch) {
        itemDetail.quantity = parseInt(qtyMatch[1]);
      }
      
      itemDetails.push(itemDetail);
    }
  }
  
  // If no items found, try to extract from quotes
  if (itemDetails.length === 0) {
    const quotedMatch = text.match(/"([^"]+)"|'([^']+)'/g);
    if (quotedMatch) {
      itemDetails.push(...quotedMatch.map(m => ({
        name: m.replace(/["']/g, ''),
        quantity: 1
      })));
    }
  }


  // Extract city
  const cities = ['mumbai', 'delhi', 'bangalore', 'bengaluru', 'hyderabad', 'chennai', 'kolkata', 'pune', 'ahmedabad', 'jaipur'];
  let city = undefined;
  for (const c of cities) {
    if (lowerText.includes(c)) {
      city = c.charAt(0).toUpperCase() + c.slice(1);
      break;
    }
  }

  // Extract address
  const addressMatch = text.match(/(?:deliver to|address is|at)\s+([^,\.]+)/i);
  const deliveryAddress = addressMatch ? addressMatch[1].trim() : undefined;

  return {
    items: itemDetails.length > 0 ? itemDetails : [{ name: 'Milk', quantity: 1 }],
    deliveryAddress,
    city
  };
}
