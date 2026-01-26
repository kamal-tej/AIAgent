import { chromium, Page, BrowserContext } from 'playwright';
import { expect } from '@playwright/test'
import { OrderRequest, OrderResponse, ItemDetails } from '../types/booking.types';
import { GoogleGenerativeAI } from '@google/generative-ai';

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

let browserInstance: BrowserContext | null = null;
let pageInstance: Page | null = null;

// AI-powered product matching
async function findBestProductMatch(
  userQuery: string,
  productNames: string[],
  packSizes: string[],
  targetWeight?: string
): Promise<number> {
  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.log('No API key, using first match');
      return 0;
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `You are a product matching assistant. Find the best matching product from the list.

User is searching for: "${userQuery}"${targetWeight ? ` with weight: "${targetWeight}"` : ''}

Available products:
${productNames.map((name, i) => `${i}. ${name} - ${packSizes[i]}`).join('\n')}

Analyze which product best matches the user's search. Consider:
- Partial name matches (e.g., "id dosa batter" matches "iD Fresh Idli & Dosa Batter")
- Brand variations and full product names
- Weight/pack size if specified

Respond with ONLY the index number (0-${productNames.length - 1}) of the best match. No other text.`;

    const result = await model.generateContent(prompt);
    const response = result.response.text().trim();
    const index = parseInt(response);
    
    if (isNaN(index) || index < 0 || index >= productNames.length) {
      console.log('Invalid AI response, using first match');
      return 0;
    }
    
    console.log(`AI matched "${userQuery}" to product ${index}: ${productNames[index]}`);
    return index;
  } catch (error) {
    console.error('AI matching error:', error);
    
    // Check if it's a Gemini API overload error
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (errorMessage.includes('quota') || 
        errorMessage.includes('rate limit') || 
        errorMessage.includes('429') ||
        errorMessage.includes('503') ||
        errorMessage.includes('RESOURCE_EXHAUSTED')) {
      console.log(errorMessage);
      throw new Error('🔄 Gemini AI is overloaded. Please try again in a few moments.');
    }
    
    // For other errors, use first match as fallback
    console.log('Using first match as fallback due to error');
    return 0;
  }
}

// Login with phone and wait for OTP
export async function loginToZepto(phone: string, onProgress?: (step: string) => void): Promise<{ success: boolean; message: string; needsOTP: boolean; savedLocations?: string[] }> {
  try {
    if (!browserInstance) {
      onProgress?.('Opening browser...');
      browserInstance = await chromium.launchPersistentContext('./user-data-dir', {
        headless: false,
        args: [
          '--start-maximized',
          // '--window-position=-2000,-2000',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ],
        permissions: ['geolocation'],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: null,
        locale: 'en-US',
        timezoneId: 'Asia/Kolkata',
        ignoreHTTPSErrors: true,
      });
      
      pageInstance = await browserInstance.newPage();
      
      // Remove automation indicators
      await pageInstance.addInitScript(() => {
        // @ts-ignore - These globals exist in browser context
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
        
        // @ts-ignore - These globals exist in browser context
        window.chrome = {
          runtime: {},
        };
        
        // @ts-ignore - These globals exist in browser context
        const originalQuery = window.navigator.permissions.query;
        // @ts-ignore - These globals exist in browser context
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: 'denied' }) :
            originalQuery(parameters)
        );
      });
    }

    const page = pageInstance!;

    onProgress?.('Navigating to Zepto...');
    await page.goto('https://www.zepto.com', { 
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await page.waitForTimeout(randomInt(3000, 5000));

    // Check if already logged in and verify phone number
    try {
      const userIcon = page.locator('//*[@aria-label="profile"]');
      await userIcon.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      console.log('User icon found:', userIcon, await userIcon.isVisible());
      if (await userIcon.isVisible({ timeout: 3000 })) {
        onProgress?.('Checking logged-in user...');
        
        // Click on Profile to check the phone number
        const profileButton = page.getByText('profile', { exact: true });
        await profileButton.waitFor({ state: 'visible', timeout: 5000 });
        await profileButton.click({ timeout: 5000 });
        
        // Get the logged-in phone number from the profile page
        // const phonePattern = /\+91[\s-]?(\d{10})/;
        // const pageText = await page.textContent('body');
        // const match = pageText?.match(phonePattern);
        // const loggedInPhone = match ? match[1] : null;
        
        // console.log('Logged-in phone:', loggedInPhone, 'Requested phone:', phone);


        
        // Check if the logged-in phone matches the provided phone
        const phoneElement = page.getByText(phone);
        await phoneElement.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
        if (await phoneElement.isVisible()) {
          onProgress?.('Already logged in with correct number! Fetching saved locations...');
          
          // Navigate back to home
          await page.goto('https://www.zepto.com', { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(randomInt(2000, 3000));
          
          // Click on Select Location button
          try {
            const addressButton = page.getByTestId("user-address");
            await addressButton.waitFor({ state: 'visible', timeout: 5000 });
            await addressButton.click({ timeout: 5000 });
            await page.waitForTimeout(1000);
            
            // Extract saved locations
            const locationElements = page.locator('//div[@data-testid="saved-address-list"]/div[@data-testid="address-item"]');
            await locationElements.first().waitFor({ state: 'visible', timeout: 5000 });
            const savedLocations = await locationElements.allTextContents();
            console.log("savedLocations 107 ", savedLocations);
            const trimmedLocations = savedLocations.map(loc => loc.trim()).filter(loc => loc.length > 0);
            
            if (trimmedLocations.length === 0) {
              return { success: false, message: 'No saved locations found. Please add a delivery address in Zepto app.', needsOTP: false };
            }
            
            onProgress?.('Locations fetched! Please select your delivery location.');
            return { 
              success: true, 
              message: 'Already logged in! Please select your delivery location from the list.', 
              needsOTP: false,
              savedLocations: trimmedLocations
            };
          } catch (locationError) {
            console.error('Failed to fetch locations:', locationError);
            return { success: true, message: 'Already logged in with correct number', needsOTP: false };
          }
        } else {
          // Phone number doesn't match, logout
          onProgress?.('Logging out current user...');
          
          try {
            const logoutButton = page.getByText('Log Out', { exact: true });
            await logoutButton.first().waitFor({ state: 'visible', timeout: 5000 });
            await logoutButton.first().click({ timeout: 5000 });
            await page.waitForTimeout(randomInt(2000, 3000));
            onProgress?.('Logged out. Proceeding with new login...');
          } catch (logoutError) {
            console.error('Logout failed:', logoutError);
            // Try to navigate back and continue with login anyway
            await page.goto('https://www.zepto.com', { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1000);
          }
        }
      }
    } catch (error) {
      console.log('Error checking logged-in user:', error);
      // If check fails, continue with login process
    }

    onProgress?.('Opening login dialog...');
    
    // Click on login/user button
    try {
      const loginButton = page.getByRole('button', { name: /Login|sign in/i });
      await loginButton.waitFor({ state: 'visible', timeout: 5000 });
      await loginButton.click({ timeout: 5000 });
    } catch {
      // Try alternate selector
      const altLoginButton = page.locator('button:has-text("Login")').first();
      await altLoginButton.waitFor({ state: 'visible', timeout: 5000 });
      await altLoginButton.click();
    }
    await page.waitForTimeout(1000);

    onProgress?.('Entering phone number...');
    
    // Enter phone number with human-like typing
    const phoneInput = page.getByPlaceholder('Enter Phone Number');
    await phoneInput.waitFor({ state: 'visible', timeout: 5000 });
    await phoneInput.click();
    await page.waitForTimeout(randomInt(300, 600));
    for (const digit of phone) {
      await phoneInput.pressSequentially(digit, { delay: randomInt(50, 150) });
    }
    await page.waitForTimeout(randomInt(500, 1000));
    const continueButton = page.getByRole('button', { name: 'Continue' });
    await continueButton.waitFor({ state: 'visible', timeout: 5000 });
    await continueButton.click();
    await page.waitForTimeout(randomInt(2000, 3000));

    onProgress?.('Waiting for OTP...');
    
    return { 
      success: true, 
      message: 'Phone number submitted. Please check OTP on your phone and enter it in the chat.', 
      needsOTP: true 
    };

  } catch (error) {
    console.error('Login error:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Login failed',
      needsOTP: false
    };
  }
}

// Select delivery location by index (1-based)
export async function selectLocation(locationIndex: number, onProgress?: (step: string) => void): Promise<{ success: boolean; message: string }> {
  try {
    if (!pageInstance) {
      return { success: false, message: 'No active session. Please login first.' };
    }

    const page = pageInstance;
    
    // Find and click the location by index (convert 1-based to 0-based)
    const locationElements = page.locator('//div[@data-testid="saved-address-list"]/div[@data-testid="address-item"]').nth(locationIndex - 1);
    
    await locationElements.waitFor({ state: 'visible', timeout: 5000 });
    await locationElements.click();
    await page.waitForTimeout(randomInt(2000, 3000));
    
    onProgress?.('Clearing cart...');
    
    // Clear the cart after selecting location
    try {
      // Go to cart page
      const cartButton = page.getByLabel('Cart');
      await cartButton.waitFor({ state: 'visible', timeout: 5000 });
      await cartButton.click();
      await page.waitForTimeout(randomInt(1500, 2500));
      
      //if location is unservicable
      const isUnserviceable = await page.getByText("Location is Unservicable").isVisible();
      if( isUnserviceable ){
        // Close browser before returning error
        await closeBrowser();
        return { success: false, message: '🚫 Riders are busy! Please try again after 15 minutes.' };
      }


      // Check if cart is already empty
      const emptyCartTextElement = page.getByText('Your cart is empty').first();
      await emptyCartTextElement.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      const emptyCartText = await emptyCartTextElement.isVisible({ timeout: 3000 });
      
      if (!emptyCartText) {
        // Remove items one by one until cart is empty
        let itemRemoved = true;
        while (itemRemoved) {
          try {
            const removeButton = page.locator('[aria-label="Remove"]').first();
            if (await removeButton.isVisible({ timeout: 2000 })) {
              await removeButton.click();
              await page.waitForTimeout(randomInt(500, 1000));
              
              // Check if cart is now empty
              const isEmpty = await page.getByText('Your cart is empty').isVisible({ timeout: 2000 });
              if (isEmpty) {
                break;
              }
            } else {
              itemRemoved = false;
            }
          } catch {
            itemRemoved = false;
          }
        }
        onProgress?.('Cart cleared!');
        // Click "Browse Products" button to go back to home
        try {
          const browseButton = page.getByRole('button', { name: 'Browse Products' });
          await browseButton.waitFor({ state: 'visible', timeout: 5000 });
          await browseButton.click();
          onProgress?.('browsed products');
          await page.waitForTimeout(randomInt(1500, 2500));
        } catch {
          // If button not found, navigate to home manually
          await page.goto('https://www.zepto.com', { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(randomInt(1500, 2500));
        }
      } else {
        // Cart already empty, go back to home
        const browseButton = page.getByText('Browse Products');
        await browseButton.waitFor({ state: 'visible', timeout: 5000 });
        await browseButton.click();
        await page.waitForTimeout(randomInt(1500, 2500));
      }
    } catch (error) {
      console.log('Error clearing cart:', error);
      // Continue anyway
    }
    
    onProgress?.('Location selected! Ready to order.');
    return { success: true, message: 'Location selected successfully! You can now place orders.' };

  } catch (error) {
    console.error('Location selection error:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Location selection failed'
    };
  }
}

// Verify OTP entered by user
export async function verifyOTP(otp: string, onProgress?: (step: string) => void): Promise<{ success: boolean; message: string; savedLocations?: string[] }> {
  try {
    if (!pageInstance) {
      return { success: false, message: 'No active session. Please start login first.' };
    }

    const page = pageInstance;
    
    onProgress?.('Entering OTP...');
    
    // Enter OTP in the input fields with human-like typing
    const otpInputs = page.locator('input[type="tel"], input[type="text"]').filter({ hasText: '' });
    await otpInputs.first().waitFor({ state: 'visible', timeout: 5000 });
    const digits = otp.split('');
    
    for (let i = 0; i < Math.min(digits.length, 6); i++) {
      await otpInputs.nth(i).click();
      await page.waitForTimeout(randomInt(100, 200));
      await otpInputs.nth(i).pressSequentially(digits[i], { delay: randomInt(50, 100) });
      await page.waitForTimeout(randomInt(150, 300));
    }

    await page.waitForTimeout(randomInt(2000, 3000));

    // Check if login successful

    try {
      await page.waitForSelector('//a[@aria-label="profile"]', { timeout: 10000 });
      onProgress?.('Login successful! Fetching saved locations...');
      
      // Click on Select Location button
      const addressButton = page.getByTestId("user-address");
      await addressButton.waitFor({ state: 'visible', timeout: 5000 });
      await addressButton.click({ timeout: 5000 });
      await page.waitForTimeout(randomInt(1500, 2500));
      
      // Extract saved locations
      const locationElements = page.locator('//div[@data-testid="saved-address-list"]/div[@data-testid="address-item"]');
      await locationElements.first().waitFor({ state: 'visible', timeout: 5000 });
      const savedLocations = await locationElements.allTextContents();
      const trimmedLocations = savedLocations.map(loc => loc.trim()).filter(loc => loc.length > 0);
      
      if (trimmedLocations.length === 0) {
        return { success: false, message: 'No saved locations found. Please add a delivery address in Zepto app.' };
      }
      
      onProgress?.('Locations fetched! Please select your delivery location.');
      return { 
        success: true, 
        message: 'Please select your delivery location from the list.', 
        savedLocations: trimmedLocations 
      };
    } catch {
      return { success: false, message: 'OTP verification failed. Please try again.' };
    }

  } catch (error) {
    console.error('OTP verification error:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : 'OTP verification failed'
    };
  }
}

export const pendingRetries = new Map<string, (action: 'retry' | 'cancel') => void>();

export function handlePaymentAction(orderId: string, action: 'retry' | 'cancel') {
  console.log(`Handling payment action for ${orderId}: ${action}`);
  const resolve = pendingRetries.get(orderId);
  if (resolve) {
    resolve(action);
    pendingRetries.delete(orderId);
  } else {
    console.log(`No pending retry found for order ${orderId}`);
  }
}

// Place order after login
export async function placeOrder(
  request: OrderRequest,
  onProgress?: (step: string, progress: number) => void,
  orderId?: string,
  updateOrderStatus?: (orderId: string, eta?: string, result?: Partial<OrderResponse>) => void
): Promise<OrderResponse> {
  try {
    if (!pageInstance || !browserInstance) {
      return {
        success: false,
        message: 'Please login first',
        error: 'No active session'
      };
    }

    const page = pageInstance;

    onProgress?.('Searching for items...', 30);

    // Open search if not already open
    try {
      const searchIcon = page.locator('//a[@data-testid="search-bar-icon"]');
      await searchIcon.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
      if (await searchIcon.isVisible({ timeout: 2000 })) {
        await searchIcon.click();
        await page.waitForTimeout(randomInt(1500, 2500));
      }
    } catch {
      // Search might already be open
    }

    const addedItems: ItemDetails[] = [];
    
    // Search and add each item
    for (const item of request.items) {
      console.log(item);
      onProgress?.(`Adding ${item.name}...`, 40);
      
      const searchInput = page.locator("//input[contains(@placeholder, 'Search')]");
      await searchInput.waitFor({ state: 'visible', timeout: 5000 });
      await searchInput.click();
      await page.waitForTimeout(randomInt(300, 600));
      await searchInput.clear();
      
      // Build search query with brand if available
      const searchQuery = item.brand ? `${item.brand} ${item.name}` : item.name;
      // Type character by character with random delays
      for (const char of searchQuery) {
        await searchInput.pressSequentially(char, { delay: randomInt(50, 150) });
      }
      await page.waitForTimeout(randomInt(300, 500));
      await page.keyboard.press('Enter');
      await page.waitForTimeout(randomInt(2500, 3500));

      // Add item - match both product name and weight using AI
      try {
        // Get all product names and weights
        const productNameLocator = page.locator('//div[@role="dialog"]//div[@data-slot-id="ProductName"] | //div[@data-slot-id="ProductName"]');
        await productNameLocator.first().waitFor({ state: 'visible', timeout: 5000 });
        const productNames = await productNameLocator.allTextContents();
        const packSizeLocator = page.locator('//div[@role="dialog"]//div[@data-slot-id="PackSize"] | // div[@data-slot-id="PackSize"]');
        await packSizeLocator.first().waitFor({ state: 'visible', timeout: 5000 });
        const packSizes = await packSizeLocator.allTextContents();

        // Try to get prices if available
        let prices: number[] = [];
        try {
          const priceLocator = page.locator('//div[@role="dialog"]//h4 | //h4');
          const priceTexts = await priceLocator.allTextContents();
          prices = priceTexts.map(text => {
            const match = text.match(/₹(\d+)/);
            return match ? parseInt(match[1]) : 50;
          });
        } catch (priceError) {
          console.log('Could not extract prices, using default');
          prices = new Array(productNames.length).fill(50);
        }
        
        console.log('Found products:', productNames);
        console.log('Pack sizes:', packSizes);
        console.log('Prices:', prices);
        
        // Use AI to find best matching product
        const matchedIndex = await findBestProductMatch(
          searchQuery,
          productNames,
          packSizes,
          item.weight
        );
        
        console.log(`AI selected product at index ${matchedIndex}: ${productNames[matchedIndex]}`);
        
        // Click ADD button for the matched product (using XPath index)
        const addButton = page.locator(`(//div[@role='dialog']//button[contains(text(), "ADD")])[${matchedIndex + 1}] | (//button[contains(text(), "ADD")])[${matchedIndex + 1}]`);
        await addButton.waitFor({ state: 'visible', timeout: 5000 });
        await addButton.click({ timeout: 5000 });
        await page.waitForTimeout(randomInt(800, 1500));
        
        // If quantity > 1, click increase quantity button
        if (item.quantity > 1) {
          const increaseButton = page.locator("//div[@role='dialog']//button[@aria-label='Increase quantity'] | //button[@aria-label='Increase quantity']").first();
          for (let i = 1; i < item.quantity; i++) {
            await increaseButton.waitFor({ state: 'visible', timeout: 3000 });
            await increaseButton.click();
            await page.waitForTimeout(randomInt(400, 700));
          }
        }

        await page.waitForTimeout(randomInt(1000, 1500));
        
        // Close item details dialog if it appears
        try {
          const closeButton = page.locator("//div[@role='dialog']//div[contains(@class,'sticky')]//button | //div[contains(@class,'sticky')]//button");
          await closeButton.waitFor({ state: 'visible', timeout: 3000 });
          await closeButton.click({ timeout: 3000 });
        } catch {
          // Dialog might not appear
        }
        
        // Add the matched product with actual Zepto product name
        addedItems.push({
          ...item,
          name: productNames[matchedIndex],  // Use actual product name from Zepto
          weight: packSizes[matchedIndex],    // Use actual pack size from Zepto
          price: prices[matchedIndex] || 50   // Use actual price from Zepto
        });

        // Try to close search, but don't fail if it's already closed
        try {
          const searchIconClose = page.locator('//a[@data-testid="search-bar-icon"]');
          await searchIconClose.waitFor({ state: 'visible', timeout: 3000 });
          await searchIconClose.click();
        } catch (searchCloseError) {
          console.log('Search icon already closed or not found, continuing...');
        }
      } catch (error) {
        console.log(`Could not add ${item.name}:`, error);
      }
    }

    onProgress?.('Going to cart...', 70);

    // Go to cart
    const cartBtn = page.getByLabel('Cart');
    await cartBtn.waitFor({ state: 'visible', timeout: 5000 });
    await cartBtn.first().click();
    await page.waitForTimeout(randomInt(2500, 3500));

    onProgress?.('Capturing cart items...', 75);

    // Extract real item names from cart using new locator
    let cartItemNames: string[] = [];
    try {
      const cartItemElements = page.locator('.ngKou');
      cartItemNames = await cartItemElements.allTextContents();
      console.log('Items found in cart (using .ngKou):', cartItemNames);
    } catch (e) {
      console.log('Error extracting items with .ngKou:', e);
    }

    // Capture screenshots of each added item in the cart
    const cartItemScreenshots: string[] = [];
    console.log('Added items:', addedItems);
    for (const addedItem of addedItems) {
      try {
        // Find the item text first using the new class if possible
        const itemText = page.locator('.ngKou').filter({ hasText: addedItem.name }).first();
        if (!(await itemText.isVisible({ timeout: 2000 }))) {
          // Fallback to general text search
          await page.getByText(addedItem.name).first().waitFor({ timeout: 5000, state: "visible" });
        }

        const container = page.locator('.ngKou').filter({ hasText: addedItem.name }).first()
            .locator('xpath=../preceding-sibling::div').first();

        const itemImage = container.locator('img').first();

        if (await itemImage.isVisible({ timeout: 3000 })) {
          const itemBuffer = await itemImage.screenshot();
          cartItemScreenshots.push(itemBuffer.toString('base64'));
          console.log(`Captured cart item image: ${addedItem.name}`);
        } else {
          // Fallback to the whole container
          const itemBuffer = await container.screenshot();
          cartItemScreenshots.push(itemBuffer.toString('base64'));
          console.log(`Captured cart item container: ${addedItem.name}`);
        }
      } catch (error) {
        console.log(`Could not capture screenshot for ${addedItem.name}:`, error);
      }
    }

    onProgress?.('Proceeding to payment...', 80);

    // Click payment button and wait for new page
    const paymentButton = page.getByText(/click to pay/i).first();
    await paymentButton.waitFor({ state: 'visible', timeout: 5000 });

    // GRASP EVERYTHING RIGHT BEFORE CLICKING
    // Extract real total price and address from cart using specific locators
    const totalPayPrice = await page.locator('.text-cta1').nth(2).textContent().catch(() => null);
    console.log("Total Pay Price:", totalPayPrice);
    const totalPrice = parseInt(totalPayPrice?.match(/₹\s*([\d,]+)/)?.[1].replace(/,/g, '') || '0') 
                      || addedItems.reduce((sum, item) => sum + (item.price || 50) * item.quantity, 0);

    const deliveryAddress = await page.locator('.__4cjoH').first().textContent().catch(() => null);
    const actualAddress = deliveryAddress?.trim() || request.deliveryAddress || 'Default Address';

    console.log(`Final Order Summary - Price: ₹${totalPrice}, Address: ${actualAddress}`);

    await paymentButton.click();

    // Wait for payment page to load
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(randomInt(4000, 5000));

    onProgress?.('Selecting UPI payment...', 85);
    const upiOption = page.locator('//div[@testid="nvb_upi"]');
    await upiOption.waitFor({ state: 'visible', timeout: 5000 });
    await upiOption.click();

    // Click UPI option
    await page.waitForTimeout(randomInt(1500, 2500));

    onProgress?.('Generating QR Code...', 90);

    // Click Generate QR Code
    const generateQRButton = page.getByText('Generate QR Code');
    await generateQRButton.waitFor({ state: 'visible', timeout: 5000 });
    await generateQRButton.click();
    console.log('Clicked Generate QR Code button');
    await page.waitForTimeout(randomInt(4000, 6000));
    console.log('Waited for QR code to generate');

    onProgress?.('Capturing QR Code...', 95);

    // Find and capture the QR code image
    let qrCodeBase64: string | undefined;
    try {
      // Try multiple selectors for QR code image
      let qrImage = page.locator('//img[@aria-label="QR Code"]').first();
      
      // Wait and check if first selector works
      try {
        await qrImage.waitFor({ state: 'visible', timeout: 5000 });
      } catch {
        // Try alternative selector - QR code might be in a canvas or different structure
        console.log('First QR selector failed, trying alternatives...');
        qrImage = page.locator('img[alt*="QR"], img[src*="qr"], canvas').first();
        await qrImage.waitFor({ state: 'visible', timeout: 3000 });
      }
      
      // Take screenshot of the QR code element
      const qrBuffer = await qrImage.screenshot();
      qrCodeBase64 = qrBuffer.toString('base64');
      
      // Save QR code to file
      const fs = await import('fs/promises');
      const qrFilePath = `./qr_codes/qr_${Date.now()}.png`;
      await fs.mkdir('./qr_codes', { recursive: true });
      await fs.writeFile(qrFilePath, qrBuffer);
      console.log(`QR Code saved to: ${qrFilePath}`);
      console.log('QR Code captured successfully!');
      
      onProgress?.('QR Code ready! Waiting for you to scan and pay...', 100);
    } catch (qrError) {
      console.error('Failed to capture QR code:', qrError);
      console.log('Trying to capture full payment section...');
      
      // Fallback: capture entire payment section
      try {
        const paymentSection = page.locator('//div[contains(@class, "payment")]').first();
        await paymentSection.waitFor({ state: 'visible', timeout: 3000 });
        const sectionBuffer = await paymentSection.screenshot();
        qrCodeBase64 = sectionBuffer.toString('base64');
        console.log('Captured payment section instead of QR');
      } catch {
        console.log('Could not capture QR code or payment section');
      }
      
      onProgress?.('QR Code generated but capture failed. Please scan from browser.', 95);
    }

    console.log('=== QR CODE READY - RETURNING TO USER ===');
    console.log('QR Code captured:', qrCodeBase64 ? 'YES' : 'NO');
    console.log('QR Code length:', qrCodeBase64?.length || 0);
    console.log('Cart items:', cartItemScreenshots.length);
    console.log('Now user will scan and pay...');

    // Return QR code immediately so user can scan
    const effectiveOrderId = orderId || `ZEPTO${Date.now()}`;
    const orderResponse: OrderResponse = {
      success: true,
      message: qrCodeBase64 
        ? '🎯 QR Code ready! Please scan the QR code to complete payment.' 
        : '💳 Payment page opened. Please complete payment in the browser.',
      orderId: effectiveOrderId,
      details: {
        items: addedItems,
        deliveryAddress: actualAddress,
        totalPrice
      },
      cartItemImages: cartItemScreenshots.length > 0 ? cartItemScreenshots : undefined,
      qrCodeImage: qrCodeBase64,
      deliveryETA: undefined // Will be updated after payment
    };

    // Start payment validation in background (don't wait)
    setTimeout(async () => {
      console.log('=== BACKGROUND: Starting payment validation ===');
      try {
        let paymentFlowResolved = false;
        while (!paymentFlowResolved) {
          // Locators for success and failure
          const etaElement = page.locator('//div[@id="eta-timer-content"]/p[1]');
          const failureParagraph = page.locator('p:has-text("payment failed")');
          const tryAgainButton = page.locator('button[aria-label="Try Again"]');

          console.log('Waiting for payment outcome (success or failure)...');
          
          // Wait for either success OR failure
          const outcome = await Promise.race([
            etaElement.waitFor({ state: 'visible', timeout: 300000 }).then(() => 'success'),
            failureParagraph.waitFor({ state: 'visible', timeout: 300000 }).then(() => 'failure')
          ]).catch(() => 'timeout');

          if (outcome === 'success') {
            const arrivingText = await etaElement.textContent();
            console.log('Order tracking text:', arrivingText);
            
            if (arrivingText?.includes('Arriving in')) {
              // Get the ETA minutes
              const etaMinutes = page.locator('//div[@id="eta-timer-content"]/p[2]');
              await etaMinutes.waitFor({ state: 'visible', timeout: 5000 });
              const etaText = await etaMinutes.textContent();
              
              console.log(`✅ Payment completed! ETA: ${etaText}`);
              
              // Update order status with delivery ETA if callback provided
              if (effectiveOrderId && updateOrderStatus && etaText) {
                updateOrderStatus(effectiveOrderId, etaText);
                console.log('Updated order status with ETA:', etaText);
              }
              
              onProgress?.(`Payment successful! Your order will arrive in ${etaText}`, 100);
              
              // Wait a bit before closing
              await page.waitForTimeout(3000);
              
              // Close browser after successful order
              await page.close();
              await browserInstance?.close();
              await closeBrowser();
              paymentFlowResolved = true;
            } else {
              // Not the success page we expected?
              paymentFlowResolved = true;
            }
          } else if (outcome === 'failure') {
            console.log('❌ Payment failed detected');
            
            // Notify frontend about failure and ask for retry/cancel
            if (effectiveOrderId && updateOrderStatus) {
              updateOrderStatus(effectiveOrderId, undefined, { 
                success: false, 
                message: '❌ Payment failed. Do you wish to retry or cancel?' 
              });
            }

            // Wait for user action from frontend
            console.log(`Waiting for user payment action for order ${effectiveOrderId}...`);
            const action = await new Promise<'retry' | 'cancel'>((resolve) => {
              pendingRetries.set(effectiveOrderId, resolve);
            });

            if (action === 'retry') {
              console.log('User chose to RETRY payment');
              
              // Click Try Again button
              await tryAgainButton.click();
              await page.waitForTimeout(randomInt(2000, 3000));
              
              // Re-run payment flow from "Click to pay"
              onProgress?.('Retrying payment...', 80);
              
              const retryPaymentButton = page.getByText(/click to pay/i).first();
              await retryPaymentButton.waitFor({ state: 'visible', timeout: 5000 });
              await retryPaymentButton.click();
              
              await page.waitForLoadState('domcontentloaded');
              await page.waitForTimeout(randomInt(4000, 5000));

              onProgress?.('Selecting UPI payment...', 85);
              const upiOption = page.locator('//div[@testid="nvb_upi"]');
              await upiOption.waitFor({ state: 'visible', timeout: 5000 });
              await upiOption.click();
              await page.waitForTimeout(randomInt(1500, 2500));

              onProgress?.('Generating new QR Code...', 90);
              const genQRButton = page.getByText('Generate QR Code');
              await genQRButton.waitFor({ state: 'visible', timeout: 5000 });
              await genQRButton.click();
              await page.waitForTimeout(randomInt(4000, 6000));

              // Capture new QR Code
              let newQrCodeBase64: string | undefined;
              try {
                let qrImg = page.locator('//img[@aria-label="QR Code"]').first();
                await qrImg.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
                if (!(await qrImg.isVisible())) {
                  qrImg = page.locator('img[alt*="QR"], img[alt*="qr"], canvas').first();
                  await qrImg.waitFor({ state: 'visible', timeout: 5000 });
                }
                const qrBuf = await qrImg.screenshot();
                newQrCodeBase64 = qrBuf.toString('base64');
              } catch (qrRetryError) {
                console.error('Failed to capture new QR code:', qrRetryError);
              }

              // Update status with new QR code
              if (effectiveOrderId && updateOrderStatus) {
                updateOrderStatus(effectiveOrderId, undefined, { 
                  success: true,
                  qrCodeImage: newQrCodeBase64,
                  message: '🎯 New QR Code ready! Please scan to retry payment.' 
                });
              }
              
              // Loop will continue and wait for success/failure again
              console.log('Restarted payment flow, waiting for outcome again...');
            } else {
              console.log('User chose to CANCEL order');
              await page.close();
              await browserInstance?.close();
              await closeBrowser();
              paymentFlowResolved = true;
            }
          } else {
            console.log('Payment tracking timed out or user cancelled manually');
            paymentFlowResolved = true;
          }
        }
      } catch (paymentError) {
        console.log('Payment tracking error:', paymentError);
      }
    }, 0);

    // Return immediately with QR code
    return orderResponse;

  } catch (error) {
    console.error('Order error:', error);
    return {
      success: false,
      message: 'Order failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Close browser
export async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
    pageInstance = null;
  }
}
