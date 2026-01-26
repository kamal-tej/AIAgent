export interface ItemDetails {
  name: string;           // e.g., "Milk"
  brand?: string;         // e.g., "Amul", "Mother Dairy"
  quantity: number;       // e.g., 2
  weight?: string;        // e.g., "1kg", "500gm", "1L"
  price?: number;         // e.g., 60
  unit?: string;          // e.g., "kg", "gm", "L", "ml", "piece"
}

export interface OrderRequest {
  items: ItemDetails[];
  phone?: string;
  deliveryAddress?: string;
  city?: string;
}

export interface LoginRequest {
  phone: string;
  otp?: string;
}

export interface SessionState {
  sessionId: string;
  phone?: string;
  isLoggedIn: boolean;
  awaitingOTP: boolean;
  step: 'ask_phone' | 'verify_otp' | 'select_location' | 'logged_in' | 'ordering';
  savedLocations?: string[];
  selectedLocation?: string;
}

export interface OrderResponse {
  success: boolean;
  message: string;
  orderId?: string;
  details?: {
    items: ItemDetails[];
    deliveryAddress: string;
    totalPrice: number;
  };
  cartItemImages?: string[];  // Base64 encoded cart item screenshots
  qrCodeImage?: string;  // Base64 encoded QR code image
  deliveryETA?: string;  // Delivery ETA (e.g., "14 mins")
  error?: string;
}

export interface OrderStatus {
  id: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  progress: number;
  currentStep: string;
  result?: OrderResponse;
  awaitingPaymentRetry?: boolean;
}
