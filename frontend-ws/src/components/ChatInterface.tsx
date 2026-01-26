import { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { io, Socket } from 'socket.io-client';
import './ChatInterface.css';

// @ts-ignore
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface Message {
  id: string;
  type: 'user' | 'ai' | 'system';
  text: string;
  timestamp: Date;
  cartItemImages?: string[];  // Base64 encoded cart item screenshots
  qrCodeImage?: string;  // Base64 encoded QR code
  locationOptions?: string[];  // For location selection buttons
  awaitingPaymentRetry?: boolean; // For payment retry buttons
  orderId?: string; // To identify which order to retry/cancel
}

interface BookingStatus {
  id: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  progress: number;
  currentStep: string;
  result?: any;
  awaitingPaymentRetry?: boolean;
}

function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentBookingId, setCurrentBookingId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversationState, setConversationState] = useState<'init' | 'waiting_phone' | 'waiting_otp' | 'waiting_location' | 'logged_in' | 'ordering'>('init');
  const [savedLocations, setSavedLocations] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const socketRef = useRef<Socket | null>(null);

  // Initialize socket and session on mount
  useEffect(() => {
    // Initialize Socket
    socketRef.current = io(API_BASE_URL);
    
    socketRef.current.on('connect', () => {
      console.log('Connected to server via WebSocket');
    });

    socketRef.current.on('login_progress', (data: { step: string }) => {
      console.log('Login progress:', data.step);
      const statusMessage: Message = {
        id: `login-status-${Date.now()}`,
        type: 'system',
        text: `🔐 ${data.step}`,
        timestamp: new Date()
      };
      setMessages(prev => {
        const filtered = prev.filter(m => !m.id.startsWith('login-status-'));
        return [...filtered, statusMessage];
      });
    });

    socketRef.current.on('order_status', (status: BookingStatus) => {
      console.log('Order status update received:', status);
      handleStatusUpdate(status);
    });

    initSession();
    initSpeechRecognition();

    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  const initSpeechRecognition = () => {
    // Check if browser supports Web Speech API
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
      console.log('Speech recognition not supported in this browser');
      return;
    }

    recognitionRef.current = new SpeechRecognition();
    recognitionRef.current.continuous = false;
    recognitionRef.current.interimResults = false;
    recognitionRef.current.lang = 'en-US';

    recognitionRef.current.onstart = () => {
      setIsRecording(true);
      console.log('Speech recognition started');
    };

    recognitionRef.current.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setInput(prev => prev + (prev ? ' ' : '') + transcript);
      console.log('Speech recognized:', transcript);
    };

    recognitionRef.current.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      setIsRecording(false);
      
      if (event.error === 'no-speech') {
        alert('No speech detected. Please try again.');
      } else if (event.error === 'not-allowed') {
        alert('Microphone access denied. Please allow microphone access in your browser settings.');
      }
    };

    recognitionRef.current.onend = () => {
      setIsRecording(false);
      console.log('Speech recognition ended');
    };
  };

  const toggleRecording = () => {
    if (!recognitionRef.current) {
      alert('Speech recognition is not supported in your browser. Please use Chrome, Edge, or Safari.');
      return;
    }

    if (isRecording) {
      recognitionRef.current.stop();
    } else {
      recognitionRef.current.start();
    }
  };

  const initSession = async () => {
    try {
      const response = await axios.post(`${API_BASE_URL}/api/booking/session/init`);
      const newSessionId = response.data.sessionId;
      setSessionId(newSessionId);
      setConversationState('waiting_phone');
      
      // Join session room via WebSocket
      socketRef.current?.emit('join_session', newSessionId);
      
      console.log('Session initialized and joined room:', newSessionId);
      
      const welcomeMessage: Message = {
        id: '1',
        type: 'ai',
        text: "Hi! 👋 I'm your Zepto ordering assistant.\n\n" + response.data.message + "\n\nPlease enter your 10-digit phone number:",
        timestamp: new Date()
      };
      setMessages([welcomeMessage]);
    } catch (error) {
      console.error('Session init error:', error);
      const errorMessage: Message = {
        id: '1',
        type: 'ai',
        text: "❌ Failed to initialize session. Please refresh the page.",
        timestamp: new Date()
      };
      setMessages([errorMessage]);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleStatusUpdate = (status: BookingStatus) => {
    // Update status message
    const statusMessage: Message = {
      id: `status-${Date.now()}`,
      type: 'system',
      text: `📍 ${status.currentStep} (${status.progress}%)`,
      timestamp: new Date()
    };

    setMessages(prev => {
      const filtered = prev.filter(m => !m.id.startsWith('status-'));
      return [...filtered, statusMessage];
    });

    // Handle payment failure with retry option
    if (status.awaitingPaymentRetry) {
      const retryMessage: Message = {
        id: `retry-${status.id}`,
        type: 'ai',
        text: `❌ Payment Failed: ${status.result?.message || 'The payment could not be processed. Would you like to try again or cancel?'}\n\nPlease click "Retry" to try the payment again or "Cancel" to stop the order.`,
        timestamp: new Date(),
        awaitingPaymentRetry: true,
        orderId: status.id
      };
      
      setMessages(prev => {
        // If we're already processing an action for this order, don't re-add the retry buttons
        if (isProcessing) return prev;
        
        const filtered = prev.filter(m => !m.id.startsWith('status-') && !m.id.startsWith('retry-'));
        return [...filtered, retryMessage];
      });
      setIsProcessing(false);
      return;
    }

    if (status.status === 'completed' || status.status === 'failed') {
      const hasDeliveryETA = !!status.result?.deliveryETA;
      
      if (status.status === 'completed' && !hasDeliveryETA) {
        // We stay in 'ordering' state and keep waiting for updates
      } else {
        setCurrentBookingId(null);
        setIsProcessing(false);
      }

      const resultMessage: Message = {
        id: status.result?.deliveryETA ? `result-completed-${status.id}` : `result-${status.id}`,
        type: 'ai',
        text: status.status === 'completed' 
          ? `${status.result?.deliveryETA 
              ? `🎉 Payment Successful! Thank you for ordering!\n\n⏱️ Your order will arrive in ${status.result.deliveryETA}\n\n` 
              : (status.result?.message ? `${status.result.message}\n\n` : '⚠️Order pending Complet the payment to place Order!\n\n')
            }${formatOrderDetails(status.result)}\n\n${status.result?.cartItemImages && status.result.cartItemImages.length > 0 ? '🛒 Here are the items in your cart:\n\n' : ''}${status.result?.qrCodeImage && !status.result?.deliveryETA ? '📱 Please scan the QR code below to complete payment:' : ''}`
          : `❌ Order failed: ${status.result?.message || 'Unknown error'}`,
        timestamp: new Date(),
        cartItemImages: status.result?.cartItemImages,
        qrCodeImage: status.result?.deliveryETA ? undefined : status.result?.qrCodeImage  // Hide QR if payment completed
      };

      // Update or add the result message
      setMessages(prev => {
        const filtered = prev.filter(m => !m.id.startsWith('status-') && !m.id.startsWith('result-') && !m.id.startsWith('retry-'));
        return [...filtered, resultMessage];
      });
      
      // Disable chat input if payment successful
      if (status.result?.deliveryETA) {
        setConversationState('init');  // Reset to disable input
      }
    }
  };

  const handlePaymentRetry = async (orderId: string) => {
    if (isProcessing) return;
    setIsProcessing(true);
    
    // Add user message for the retry action
    const userMsg: Message = {
      id: `user-retry-${Date.now()}`,
      type: 'user',
      text: 'Retry payment',
      timestamp: new Date()
    };
    setMessages(prev => [...prev.filter(m => !m.awaitingPaymentRetry), userMsg]);

    try {
      await axios.post(`${API_BASE_URL}/api/booking/payment-action`, {
        orderId,
        action: 'retry'
      });
    } catch (error) {
      console.error('Failed to retry payment:', error);
      setIsProcessing(false);
    }
  };

  const handlePaymentCancel = async (orderId: string) => {
    if (isProcessing) return;
    setIsProcessing(true);
    
    // Add user message for the cancel action
    const userMsg: Message = {
      id: `user-cancel-${Date.now()}`,
      type: 'user',
      text: 'Cancel order',
      timestamp: new Date()
    };
    setMessages(prev => [...prev.filter(m => !m.awaitingPaymentRetry), userMsg]);

    try {
      await axios.post(`${API_BASE_URL}/api/booking/payment-action`, {
        orderId,
        action: 'cancel'
      });
      setConversationState('init');
    } catch (error) {
      console.error('Failed to cancel payment:', error);
    }
    setIsProcessing(false);
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Removed polling useEffect as we are using WebSockets

  const formatOrderDetails = (result: any) => {
    if (!result?.details) return '';
    const d = result.details;
    const itemsText = d.items.map((item: any) => `${item.name} (${item.quantity})`).join(', ');
    const totalQuantity = d.items.reduce((sum: number, item: any) => sum + (item.quantity || 0), 0);
    return `🛒 Items: ${itemsText}\n📦 Total Quantity: ${totalQuantity}\n📍 Address: ${d.deliveryAddress}\n💰 Total: ₹${d.totalPrice}`;
  };

  const handleLocationSelect = async (locationIndex: number) => {
    if (isProcessing) return;
    setIsProcessing(true);

    const selectedLocation = savedLocations[locationIndex];
    
    const userMessage: Message = {
      id: `user-${Date.now()}`,
      type: 'user',
      text: `📍 ${selectedLocation}`,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, userMessage]);

    try {
      const aiResponse: Message = {
        id: `ai-${Date.now()}`,
        type: 'ai',
        text: '📍 Selecting location...',
        timestamp: new Date()
      };
      setMessages(prev => [...prev, aiResponse]);

      const locationResponse = await axios.post(`${API_BASE_URL}/api/booking/select-location`, {
        sessionId,
        locationIndex: locationIndex + 1  // Send 1-based index (1, 2, 3, etc.)
      });

      if (locationResponse.data.isLoggedIn) {
        setConversationState('logged_in');
        const successMessage: Message = {
          id: `ai-${Date.now()}-success`,
          type: 'ai',
          text: `✅ ${locationResponse.data.message}\n\nNow, what would you like to order?\n\nExample: "2 Amul milk 1L and Britannia bread"`,
          timestamp: new Date()
        };
        setMessages(prev => [...prev.filter(m => m.id !== aiResponse.id), successMessage]);
      }
    } catch (error: any) {
      const errorMessage: Message = {
        id: `error-${Date.now()}`,
        type: 'ai',
        text: `❌ ${error.response?.data?.message || error.message}`,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMessage]);
      
      // If riders are busy (unserviceable location), reset to initial state
      if (error.response?.data?.message?.includes('Riders are busy')) {
        setConversationState('init');
        setIsProcessing(false);
        
        // Show refresh instruction after a delay
        setTimeout(() => {
          const refreshMessage: Message = {
            id: `refresh-${Date.now()}`,
            type: 'system',
            text: '🔄 Browser closed. Please refresh the page and try again after 15 minutes.',
            timestamp: new Date()
          };
          setMessages(prev => [...prev, refreshMessage]);
        }, 1000);
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isProcessing || !sessionId) return;

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      type: 'user',
      text: input,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    const userInput = input.trim();
    setInput('');
    setIsProcessing(true);

    try {
      // Handle based on conversation state
      if (conversationState === 'waiting_phone') {
        // User entered phone number
        const phoneRegex = /^\d{10}$/;
        if (!phoneRegex.test(userInput)) {
          throw new Error('Please enter a valid 10-digit phone number');
        }

        const aiResponse: Message = {
          id: `ai-${Date.now()}`,
          type: 'ai',
          text: '⏳ Wait a sec... I am logging you in...',
          timestamp: new Date()
        };
        setMessages(prev => [...prev, aiResponse]);

        console.log('Sending login request with sessionId:', sessionId);
        
        const loginResponse = await axios.post(`${API_BASE_URL}/api/booking/login`, {
          sessionId,
          phone: userInput
        });

        console.log('Login response:', loginResponse.data);

        if (loginResponse.data.needsOTP) {
          setConversationState('waiting_otp');
          const otpMessage: Message = {
            id: `ai-${Date.now()}-otp`,
            type: 'ai',
            text: `✅ ${loginResponse.data.message}\n\nPlease enter the OTP:`,
            timestamp: new Date()
          };
          setMessages(prev => [...prev.filter(m => m.id !== aiResponse.id), otpMessage]);
          setIsProcessing(false);
        } else if (loginResponse.data.needsLocationSelection && loginResponse.data.savedLocations) {
          setConversationState('waiting_location');
          setSavedLocations(loginResponse.data.savedLocations);
          
          const locationMessage: Message = {
            id: `ai-${Date.now()}-location`,
            type: 'ai',
            text: `✅ ${loginResponse.data.message}\n\n📍 Please select your delivery location:`,
            timestamp: new Date(),
            locationOptions: loginResponse.data.savedLocations
          };
          setMessages(prev => [...prev.filter(m => m.id !== aiResponse.id), locationMessage]);
          setIsProcessing(false);
        } else if (loginResponse.data.isLoggedIn) {
          setConversationState('logged_in');
          const successMessage: Message = {
            id: `ai-${Date.now()}-success`,
            type: 'ai',
            text: `✅ ${loginResponse.data.message}\n\nNow, what would you like to order?\n\nExample: "2 Amul milk 1L and Britannia bread"`,
            timestamp: new Date()
          };
          setMessages(prev => [...prev.filter(m => m.id !== aiResponse.id), successMessage]);
          setIsProcessing(false);
        }

      } else if (conversationState === 'waiting_otp') {
        // User entered OTP
        const otpRegex = /^\d{4,6}$/;
        if (!otpRegex.test(userInput)) {
          throw new Error('Please enter a valid OTP (4-6 digits)');
        }

        const aiResponse: Message = {
          id: `ai-${Date.now()}`,
          type: 'ai',
          text: '🔐 Verifying OTP...',
          timestamp: new Date()
        };
        setMessages(prev => [...prev, aiResponse]);

        const verifyResponse = await axios.post(`${API_BASE_URL}/api/booking/verify-otp`, {
          sessionId,
          otp: userInput
        });

        if (verifyResponse.data.needsLocationSelection && verifyResponse.data.savedLocations) {
          setConversationState('waiting_location');
          setSavedLocations(verifyResponse.data.savedLocations);
          
          const locationMessage: Message = {
            id: `ai-${Date.now()}-location`,
            type: 'ai',
            text: `✅ ${verifyResponse.data.message}\n\n📍 Please select your delivery location:`,
            timestamp: new Date(),
            locationOptions: verifyResponse.data.savedLocations
          };
          setMessages(prev => [...prev.filter(m => m.id !== aiResponse.id), locationMessage]);
          setIsProcessing(false);
        } else if (verifyResponse.data.isLoggedIn) {
          setConversationState('logged_in');
          const successMessage: Message = {
            id: `ai-${Date.now()}-success`,
            type: 'ai',
            text: `✅ ${verifyResponse.data.message}\n\nNow, what would you like to order?\n\nExample: "2 Amul milk 1L and Britannia bread"`,
            timestamp: new Date()
          };
          setMessages(prev => [...prev.filter(m => m.id !== aiResponse.id), successMessage]);
          setIsProcessing(false);
        }

      } else if (conversationState === 'waiting_location') {
        // User selected a location
        const aiResponse: Message = {
          id: `ai-${Date.now()}`,
          type: 'ai',
          text: '📍 Selecting location...',
          timestamp: new Date()
        };
        setMessages(prev => [...prev, aiResponse]);

        // Determine location index
        let locIndex = parseInt(userInput);
        if (isNaN(locIndex) || locIndex <= 0 || locIndex > savedLocations.length) {
          locIndex = 1; // Default to first location if invalid input
        }

        const locationResponse = await axios.post(`${API_BASE_URL}/api/booking/select-location`, {
          sessionId,
          locationIndex: locIndex
        });

        if (locationResponse.data.isLoggedIn) {
          setConversationState('logged_in');
          const successMessage: Message = {
            id: `ai-${Date.now()}-success`,
            type: 'ai',
            text: `✅ ${locationResponse.data.message}\n\nNow, what would you like to order?\n\nExample: "2 Amul milk 1L and Britannia bread"`,
            timestamp: new Date()
          };
          setMessages(prev => [...prev.filter(m => m.id !== aiResponse.id), successMessage]);
          setIsProcessing(false);
        }

      } else if (conversationState === 'logged_in') {
        // User entered order details
        setConversationState('ordering');

        const aiResponse: Message = {
          id: `ai-${Date.now()}`,
          type: 'ai',
          text: '🤖 Understanding your order...',
          timestamp: new Date()
        };
        setMessages(prev => [...prev, aiResponse]);

        const parseResponse = await axios.post(`${API_BASE_URL}/api/booking/parse`, {
          text: userInput,
          sessionId
        });

        const orderDetails = parseResponse.data;

        // Show parsed details with item info
        const itemsList = orderDetails.items.map((item: any) => 
          `• ${item.quantity}x ${item.brand ? item.brand + ' ' : ''}${item.name}${item.weight ? ' ' + item.weight : ''}`
        ).join('\n');

        const confirmMessage: Message = {
          id: `confirm-${Date.now()}`,
          type: 'ai',
          text: `I understand you want to order:\n\n${itemsList}\n📱 Phone: ${orderDetails.phone}\n${orderDetails.deliveryAddress ? `📍 Address: ${orderDetails.deliveryAddress}\n` : ''}\n✅ Starting order now...`,
          timestamp: new Date()
        };
        setMessages(prev => [...prev.filter(m => m.id !== aiResponse.id), confirmMessage]);

        // Start order
        const orderResponse = await axios.post(`${API_BASE_URL}/api/booking/start`, {
          ...orderDetails,
          sessionId
        });
        
        if (orderResponse.data.success) {
          const orderId = orderResponse.data.bookingId;
          setCurrentBookingId(orderId);
          console.log(currentBookingId);
          // Join order room via WebSocket
          socketRef.current?.emit('join_order', orderId);
        } else {
          throw new Error(orderResponse.data.message);
        }
      }

    } catch (error: any) {
      setIsProcessing(false);
      const errorMessage: Message = {
        id: `error-${Date.now()}`,
        type: 'ai',
        text: `❌ ${error.response?.data?.message || error.message}`,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMessage]);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-interface">
      <div className="chat-messages">
        {messages.map(msg => (
          <div key={msg.id} className={`message message-${msg.type}`}>
            <div className="message-content">
              {msg.text.split('\n').map((line, i) => (
                <span key={i}>
                  {line}
                  <br />
                </span>
              ))}
              {msg.cartItemImages && msg.cartItemImages.length > 0 && (
                <div style={{ marginTop: '15px' }}>
                  <div style={{ 
                    display: 'grid', 
                    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                    gap: '10px',
                    marginBottom: '15px'
                  }}>
                    {msg.cartItemImages.map((img, idx) => (
                      <img 
                        key={idx}
                        src={`data:image/png;base64,${img}`} 
                        alt={`Cart Item ${idx + 1}`}
                        style={{ 
                          width: '100%',
                          border: '2px solid #e0e0e0', 
                          borderRadius: '8px',
                          padding: '5px',
                          backgroundColor: 'white'
                        }} 
                      />
                    ))}
                  </div>
                </div>
              )}
              {msg.qrCodeImage && (() => {
                console.log('Rendering QR code for message:', msg.id, 'QR length:', msg.qrCodeImage?.length);
                return (
                  <div style={{ marginTop: '10px', textAlign: 'center' }}>
                    <img 
                      src={`data:image/png;base64,${msg.qrCodeImage}`} 
                      alt="QR Code for Payment" 
                      style={{ 
                        maxWidth: '300px', 
                        border: '2px solid #ccc', 
                        borderRadius: '8px',
                        padding: '10px',
                        backgroundColor: 'white'
                      }}
                      onLoad={() => console.log('QR image loaded successfully')}
                      onError={(e) => console.error('QR image failed to load:', e)}
                    />
                  </div>
                );
              })()}
              {msg.locationOptions && (
                <div style={{ marginTop: '15px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {msg.locationOptions.map((location, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleLocationSelect(idx)}
                      disabled={isProcessing}
                      style={{
                        padding: '12px 16px',
                        backgroundColor: '#007bff',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: isProcessing ? 'not-allowed' : 'pointer',
                        fontSize: '14px',
                        textAlign: 'left',
                        transition: 'background-color 0.2s',
                        opacity: isProcessing ? 0.6 : 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px'
                      }}
                      onMouseEnter={(e) => !isProcessing && (e.currentTarget.style.backgroundColor = '#0056b3')}
                      onMouseLeave={(e) => !isProcessing && (e.currentTarget.style.backgroundColor = '#007bff')}
                    >
                      <span style={{ 
                        backgroundColor: 'rgba(255,255,255,0.2)', 
                        padding: '2px 8px', 
                        borderRadius: '4px',
                        fontWeight: 'bold'
                      }}>
                        {idx + 1}
                      </span>
                      📍 {location}
                    </button>
                  ))}
                </div>
              )}
              {msg.awaitingPaymentRetry && msg.orderId && (
                <div style={{ marginTop: '15px', display: 'flex', gap: '10px' }}>
                  <button
                    onClick={() => handlePaymentRetry(msg.orderId!)}
                    disabled={isProcessing}
                    style={{
                      flex: 1,
                      padding: '12px',
                      backgroundColor: '#28a745',
                      color: 'white',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: isProcessing ? 'not-allowed' : 'pointer',
                      fontWeight: 'bold',
                      opacity: isProcessing ? 0.6 : 1
                    }}
                  >
                    🔄 Retry Payment
                  </button>
                  <button
                    onClick={() => handlePaymentCancel(msg.orderId!)}
                    disabled={isProcessing}
                    style={{
                      flex: 1,
                      padding: '12px',
                      backgroundColor: '#dc3545',
                      color: 'white',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: isProcessing ? 'not-allowed' : 'pointer',
                      fontWeight: 'bold',
                      opacity: isProcessing ? 0.6 : 1
                    }}
                  >
                    ❌ Cancel Order
                  </button>
                </div>
              )}
            </div>
            <div className="message-time">
              {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-container">
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder={
            conversationState === 'waiting_phone' ? "Enter your 10-digit phone number..." :
            conversationState === 'waiting_otp' ? "Enter OTP (4-6 digits)..." :
            conversationState === 'logged_in' ? "What would you like to order? e.g., '2 Amul milk 1L and bread'" :
            conversationState === 'init' ? "Order completed! Refresh to start new order." :
            "Loading..."
          }
          disabled={isProcessing || conversationState === 'init'}
          rows={2}
        />
        <button 
          className="chat-mic-button" 
          onClick={toggleRecording}
          disabled={isProcessing || conversationState === 'init'}
          style={{
            backgroundColor: isRecording ? '#ff4444' : '#28a745',
            animation: isRecording ? 'pulse 1s infinite' : 'none'
          }}
          title={isRecording ? 'Stop recording' : 'Start voice input'}
        >
          {isRecording ? '⏸️' : '🎤'}
        </button>
        <button 
          className="chat-send-button" 
          onClick={handleSend}
          disabled={isProcessing || !input.trim() || conversationState === 'init'}
        >
          {isProcessing ? '⏳' : '🚀'} Send
        </button>
      </div>

      <div className="chat-examples">
        <p>
          {conversationState === 'logged_in' 
            ? 'Try: "2 Amul milk 1L, Britannia bread 400gm and eggs" or "Tata tea 250gm"'
            : 'Secure login with OTP verification'}
        </p>
      </div>
    </div>
  );
}

export default ChatInterface;
