/**
 * Application error with an HTTP status. Everything thrown on purpose inside the
 * backend should be an AppError so the error middleware can answer cleanly.
 */
export class AppError extends Error {
  constructor(message, status = 400, code = '') {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code || (status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'bad_request');
  }
}

export const badRequest = (message, code) => new AppError(message, 400, code);
export const unauthorized = (message = 'Token kerak yoki noto‘g‘ri.', code) => new AppError(message, 401, code);
export const forbidden = (message, code) => new AppError(message, 403, code);
export const notFound = (message = 'Topilmadi.', code) => new AppError(message, 404, code);
export const conflict = (message, code) => new AppError(message, 409, code);
export const upstream = (message, code) => new AppError(message, 502, code);

/** Normalise any thrown value into `{ status, message, code }`. */
export function toHttpError(error) {
  if (error instanceof AppError) {
    return { status: error.status, message: error.message, code: error.code };
  }
  const status = Number(error?.status) || 500;
  return {
    status,
    message: status >= 500 ? String(error?.message || 'Server xatosi') : String(error?.message || 'Xato'),
    code: error?.code || 'internal_error'
  };
}
