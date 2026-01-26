import { Router, Request, Response } from 'express';
import { loginToZepto, verifyOTP, selectLocation, placeOrder, handlePaymentAction } from '../agents/ZeptoAgent';
import { OrderRequest, OrderStatus, SessionState } from '../types/booking.types';
import { parseOrderWithAI, parseOrderWithRegex } from '../services/nlpService';
import { getIO } from '../socket';

const router = Router();
const orderStatuses = new Map<string, OrderStatus>();
const sessions = new Map<string, SessionState>();

// Initialize session
router.post('/session/init', (req: Request, res: Response) => {
  const sessionId = `session_${Date.now()}`;
  
  sessions.set(sessionId, {
    sessionId,
    isLoggedIn: false,
    awaitingOTP: false,
    step: 'ask_phone'
  });

  console.log('New session created:', sessionId);
  console.log('Total sessions:', sessions.size);

  res.json({
    success: true,
    sessionId,
    message: 'Welcome! Please provide your phone number to get started.',
    needsPhone: true
  });
});

// Login with phone
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { sessionId, phone } = req.body;

    console.log('Login request - sessionId:', sessionId);
    console.log('Current sessions:', Array.from(sessions.keys()));

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid session. Please start a new session.'
      });
    }

    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid 10-digit phone number.'
      });
    }

    const session = sessions.get(sessionId)!;

    // Start login process
    const result = await loginToZepto(phone, (step) => {
      console.log(`Login step: ${step}`);
      getIO().to(sessionId).emit('login_progress', { step });
    });

    if (result.needsOTP) {
      session.phone = phone;
      session.awaitingOTP = true;
      session.step = 'verify_otp';
      sessions.set(sessionId, session);

      res.json({
        success: true,
        message: result.message,
        needsOTP: true
      });
    } else if (result.success && result.savedLocations) {
      // Already logged in, has saved locations
      session.phone = phone;
      session.savedLocations = result.savedLocations;
      session.step = 'select_location';
      sessions.set(sessionId, session);

      res.json({
        success: true,
        message: result.message,
        savedLocations: result.savedLocations,
        needsLocationSelection: true
      });
    } else if (result.success) {
      session.phone = phone;
      session.isLoggedIn = true;
      session.awaitingOTP = false;
      session.step = 'logged_in';
      sessions.set(sessionId, session);

      res.json({
        success: true,
        message: result.message,
        isLoggedIn: true,
        readyForOrder: true
      });
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Verify OTP
router.post('/verify-otp', async (req: Request, res: Response) => {
  try {
    const { sessionId, otp } = req.body;

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid session'
      });
    }

    if (!otp || !/^\d{4,6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid OTP (4-6 digits)'
      });
    }

    const session = sessions.get(sessionId)!;

    if (!session.awaitingOTP) {
      return res.status(400).json({
        success: false,
        message: 'No OTP verification pending'
      });
    }

    // Verify OTP
    const result = await verifyOTP(otp, (step) => {
      console.log(`OTP step: ${step}`);
      getIO().to(sessionId).emit('login_progress', { step });
    });

    if (result.success && result.savedLocations) {
      session.savedLocations = result.savedLocations;
      session.step = 'select_location';
      sessions.set(sessionId, session);

      res.json({
        success: true,
        message: result.message,
        savedLocations: result.savedLocations,
        needsLocationSelection: true
      });
    } else if (result.success) {
      session.isLoggedIn = true;
      session.awaitingOTP = false;
      session.step = 'logged_in';
      sessions.set(sessionId, session);

      res.json({
        success: true,
        message: result.message,
        isLoggedIn: true,
        readyForOrder: true
      });
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    console.error('OTP verification error:', error);
    res.status(500).json({
      success: false,
      message: 'OTP verification failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Select delivery location
router.post('/select-location', async (req: Request, res: Response) => {
  try {
    const { sessionId, locationIndex } = req.body;

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid session'
      });
    }

    if (!locationIndex || typeof locationIndex !== 'number') {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid location index'
      });
    }

    const session = sessions.get(sessionId)!;

    if (session.step !== 'select_location') {
      return res.status(400).json({
        success: false,
        message: 'No location selection pending'
      });
    }

    if (!session.savedLocations || session.savedLocations.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No saved locations found'
      });
    }

    // Convert 1-based index to 0-based and get location
    const location = session.savedLocations[locationIndex - 1];
    
    if (!location) {
      return res.status(400).json({
        success: false,
        message: 'Invalid location index'
      });
    }

    // Select location by index
    const result = await selectLocation(locationIndex, (step) => {
      console.log(`Location selection step: ${step}`);
      getIO().to(sessionId).emit('login_progress', { step });
    });

    if (result.success) {
      session.isLoggedIn = true;
      session.selectedLocation = location;
      session.step = 'logged_in';
      sessions.set(sessionId, session);

      res.json({
        success: true,
        message: result.message,
        isLoggedIn: true,
        readyForOrder: true
      });
    } else {
      // Check if it's an unserviceable location error
      if (result.message.includes('Riders are busy')) {
        // Reset session to allow new login after browser closes
        session.step = 'ask_phone';
        session.isLoggedIn = false;
        sessions.set(sessionId, session);
      }
      res.status(400).json(result);
    }

  } catch (error) {
    console.error('Location selection error:', error);
    res.status(500).json({
      success: false,
      message: 'Location selection failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Parse natural language order request using AI/regex
router.post('/parse', async (req: Request, res: Response) => {
  try {
    const { text, sessionId } = req.body;
    
    if (!text) {
      return res.status(400).json({
        success: false,
        message: 'No text provided'
      });
    }

    // Check session if provided
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      if (!session.isLoggedIn) {
        return res.status(400).json({
          success: false,
          message: 'Please login first',
          needsLogin: true
        });
      }
    }

    let parsed: OrderRequest;

    // Try AI parsing first, fallback to regex
    try {
      if (process.env.GEMINI_API_KEY) {
        console.log('Using AI-powered NLP parsing...');
        parsed = await parseOrderWithAI(text);
      } else {
        console.log('Using regex-based parsing (no OpenAI key)...');
        parsed = parseOrderWithRegex(text);
      }
    } catch (aiError) {
      console.log('AI parsing failed, using regex fallback...');
      parsed = parseOrderWithRegex(text);
    }

    if (!parsed.items || parsed.items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Could not understand the order request. Please include items to order.'
      });
    }

    // Add phone and address from session if available
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      if (session.phone) {
        parsed.phone = session.phone;
      }
      if (!parsed.deliveryAddress && session.selectedLocation) {
        parsed.deliveryAddress = session.selectedLocation;
      }
    }

    res.json(parsed);

  } catch (error) {
    console.error('Error parsing text:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to parse order request',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Start a new order
router.post('/start', async (req: Request, res: Response) => {
  try {
    const orderRequest: OrderRequest = req.body;
    const { sessionId } = req.body;
    
    // Check session
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      if (!session.isLoggedIn) {
        return res.status(400).json({
          success: false,
          message: 'Please login first',
          needsLogin: true
        });
      }
      session.step = 'ordering';
      sessions.set(sessionId, session);
    }

    // Validate request
    if (!orderRequest.items || orderRequest.items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: items are required'
      });
    }

    const orderId = `order_${Date.now()}`;
    
    // Initialize order status
    orderStatuses.set(orderId, {
      id: orderId,
      status: 'pending',
      progress: 0,
      currentStep: 'Initializing...'
    });

    // Start order process asynchronously
    processOrder(orderId, orderRequest);

    res.json({
      success: true,
      bookingId: orderId,
      message: 'Order process started. Use the order ID to check status.'
    });

  } catch (error) {
    console.error('Error starting order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start order process',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get order status
router.get('/status/:bookingId', (req: Request, res: Response) => {
  const { bookingId } = req.params;
  const status = orderStatuses.get(bookingId);

  if (!status) {
    return res.status(404).json({
      success: false,
      message: 'Order not found'
    });
  }

  res.json(status);
});

// Get all orders
router.get('/all', (req: Request, res: Response) => {
  const allOrders = Array.from(orderStatuses.values());
  res.json({ orders: allOrders });
});

// Payment action (retry/cancel)
router.post('/payment-action', (req: Request, res: Response) => {
  const { orderId, action } = req.body;
  if (!orderId || !action) {
    return res.status(400).json({ success: false, message: 'Missing orderId or action' });
  }
  
  // Update status immediately to prevent duplicate clicks/stale UI
  const status = orderStatuses.get(orderId);
  if (status) {
    status.awaitingPaymentRetry = false;
    orderStatuses.set(orderId, status);
  }
  
  handlePaymentAction(orderId, action);
  res.json({ success: true });
});

async function processOrder(orderId: string, request: OrderRequest) {
  try {
    // Update status callback
    const updateStatus = (step: string, progress: number) => {
      const status = orderStatuses.get(orderId);
      if (status) {
        status.currentStep = step;
        status.progress = progress;
        status.status = 'in-progress';
        status.awaitingPaymentRetry = false; // Reset retry flag on any progress
        orderStatuses.set(orderId, status);
        getIO().to(orderId).emit('order_status', status);
      }
    };

    // Callback to update order status during payment flow
    const updateOrder = (orderIdToUpdate: string, eta?: string, result?: any) => {
      const status = orderStatuses.get(orderIdToUpdate);
      if (status) {
        if (eta) {
          if (!status.result) status.result = { success: true, message: '' };
          status.result.deliveryETA = eta;
          status.result.message = `✅ Payment successful! Your order will arrive in ${eta}. Thank you for ordering!`;
          status.currentStep = `Order confirmed! Arriving in ${eta}`;
          status.status = 'completed';
          status.awaitingPaymentRetry = false;
        }
        
        if (result) {
          if (!status.result) status.result = { success: result.success ?? true, message: result.message ?? '' };
          status.result = { ...status.result, ...result };
          if (result.message) {
            status.currentStep = result.message;
          }
          // Set retry flag if payment failed
          if (result.message?.includes('failed')) {
            status.status = 'in-progress'; // Keep it in progress so user can retry
            status.awaitingPaymentRetry = true;
          }
          // Reset retry flag if new QR code generated
          if (result.qrCodeImage) {
            status.awaitingPaymentRetry = false;
            status.status = 'completed'; // Set to completed so frontend shows the QR result
          }
        }
        
        orderStatuses.set(orderIdToUpdate, status);
        console.log('Order status updated:', status.currentStep);
        getIO().to(orderIdToUpdate).emit('order_status', status);
      }
    };

    // Execute order
    const result = await placeOrder(request, updateStatus, orderId, updateOrder);

    // Update final status
    const status = orderStatuses.get(orderId);
    if (status) {
      status.status = result.success ? 'completed' : 'failed';
      status.progress = 100;
      status.currentStep = result.success ? 'Order placed!' : 'Order failed';
      status.result = result;
      orderStatuses.set(orderId, status);
      getIO().to(orderId).emit('order_status', status);
    }

  } catch (error) {
    console.error('Order process error:', error);
    const status = orderStatuses.get(orderId);
    if (status) {
      status.status = 'failed';
      status.progress = 100;
      status.currentStep = 'Error occurred';
      status.result = {
        success: false,
        message: 'Order failed due to an error',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
      orderStatuses.set(orderId, status);
      getIO().to(orderId).emit('order_status', status);
    }
  }
}

export default router;
