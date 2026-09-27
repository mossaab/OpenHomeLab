export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function apiCall<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('auth_token');
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };

  const response = await fetch(`/api${endpoint}`, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    }
  });

  if (!response.ok) {
    const isAuthEndpoint = endpoint.startsWith('/login') || endpoint.startsWith('/setup');
    if (response.status === 401 && !isAuthEndpoint) {
      localStorage.removeItem('auth_token');
      window.dispatchEvent(new Event('openhomelab:auth-expired'));
      throw new ApiError(401, 'Session expired');
    }
    let message = 'An error occurred';
    const errData = await response.json().catch(() => null);
    message = errData?.error || message;
    throw new ApiError(response.status, message);
  }

  return response.json();
}
