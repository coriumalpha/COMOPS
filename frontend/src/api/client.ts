export type ApiError = { error?: string; title?: string; detail?: string; traceId?: string };

export class ApiRequestError extends Error {
  constructor(public status: number, message: string, public traceId?: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'include',
      headers: options.body instanceof FormData ? undefined : { 'content-type': 'application/json', ...(options.headers || {}) },
      ...options
    });
  } catch {
    throw new ApiRequestError(0, 'No hay conexión con el servidor. Revisa red o contenedores.');
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({} as ApiError));
    const message = error.error || error.title || error.detail || `Error HTTP ${response.status}`;
    throw new ApiRequestError(response.status, error.traceId ? `${message} · ${error.traceId}` : message, error.traceId);
  }
  if (response.status === 204) return undefined as T;
  return response.json().catch(() => {
    throw new ApiRequestError(response.status, 'La respuesta del servidor no es JSON válido.');
  }) as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' })
};

export const euro = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
export const dateTime = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' });
export const dateOnly = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeZone: 'Europe/Madrid' });
