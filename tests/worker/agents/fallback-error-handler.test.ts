import { describe, it, expect } from 'bun:test';

import { shouldFallbackToCodex, isAbortError } from '../../../src/services/worker/agents/FallbackErrorHandler.js';
import { FALLBACK_ERROR_PATTERNS } from '../../../src/services/worker/agents/types.js';

describe('FallbackErrorHandler', () => {
  describe('FALLBACK_ERROR_PATTERNS', () => {
    it('should contain all 7 expected patterns', () => {
      expect(FALLBACK_ERROR_PATTERNS).toHaveLength(7);
      expect(FALLBACK_ERROR_PATTERNS).toContain('429');
      expect(FALLBACK_ERROR_PATTERNS).toContain('500');
      expect(FALLBACK_ERROR_PATTERNS).toContain('502');
      expect(FALLBACK_ERROR_PATTERNS).toContain('503');
      expect(FALLBACK_ERROR_PATTERNS).toContain('ECONNREFUSED');
      expect(FALLBACK_ERROR_PATTERNS).toContain('ETIMEDOUT');
      expect(FALLBACK_ERROR_PATTERNS).toContain('fetch failed');
    });
  });

  describe('shouldFallbackToCodex', () => {
    describe('returns true for fallback patterns', () => {
      it('should return true for 429 rate limit errors', () => {
        expect(shouldFallbackToCodex('Rate limit exceeded: 429')).toBe(true);
        expect(shouldFallbackToCodex(new Error('429 Too Many Requests'))).toBe(true);
      });

      it('should return true for 500 internal server errors', () => {
        expect(shouldFallbackToCodex('500 Internal Server Error')).toBe(true);
        expect(shouldFallbackToCodex(new Error('Server returned 500'))).toBe(true);
      });

      it('should return true for 502 bad gateway errors', () => {
        expect(shouldFallbackToCodex('502 Bad Gateway')).toBe(true);
        expect(shouldFallbackToCodex(new Error('Upstream returned 502'))).toBe(true);
      });

      it('should return true for 503 service unavailable errors', () => {
        expect(shouldFallbackToCodex('503 Service Unavailable')).toBe(true);
        expect(shouldFallbackToCodex(new Error('Server is 503'))).toBe(true);
      });

      it('should return true for ECONNREFUSED errors', () => {
        expect(shouldFallbackToCodex('connect ECONNREFUSED 127.0.0.1:8080')).toBe(true);
        expect(shouldFallbackToCodex(new Error('ECONNREFUSED'))).toBe(true);
      });

      it('should return true for ETIMEDOUT errors', () => {
        expect(shouldFallbackToCodex('connect ETIMEDOUT')).toBe(true);
        expect(shouldFallbackToCodex(new Error('Request ETIMEDOUT'))).toBe(true);
      });

      it('should return true for fetch failed errors', () => {
        expect(shouldFallbackToCodex('fetch failed')).toBe(true);
        expect(shouldFallbackToCodex(new Error('fetch failed: network error'))).toBe(true);
      });
    });

    describe('returns false for non-fallback errors', () => {
      it('should return false for 400 Bad Request', () => {
        expect(shouldFallbackToCodex('400 Bad Request')).toBe(false);
        expect(shouldFallbackToCodex(new Error('400 Invalid argument'))).toBe(false);
      });

      it('should return false for 401 Unauthorized', () => {
        expect(shouldFallbackToCodex('401 Unauthorized')).toBe(false);
      });

      it('should return false for 403 Forbidden', () => {
        expect(shouldFallbackToCodex('403 Forbidden')).toBe(false);
      });

      it('should return false for 404 Not Found', () => {
        expect(shouldFallbackToCodex('404 Not Found')).toBe(false);
      });

      it('should return false for generic errors', () => {
        expect(shouldFallbackToCodex('Something went wrong')).toBe(false);
        expect(shouldFallbackToCodex(new Error('Unknown error'))).toBe(false);
      });
    });

    describe('handles various error types', () => {
      it('should handle string errors', () => {
        expect(shouldFallbackToCodex('429 rate limited')).toBe(true);
        expect(shouldFallbackToCodex('invalid input')).toBe(false);
      });

      it('should handle Error objects', () => {
        expect(shouldFallbackToCodex(new Error('429 Too Many Requests'))).toBe(true);
        expect(shouldFallbackToCodex(new Error('Bad Request'))).toBe(false);
      });

      it('should handle objects with message property', () => {
        expect(shouldFallbackToCodex({ message: '503 unavailable' })).toBe(true);
        expect(shouldFallbackToCodex({ message: 'ok' })).toBe(false);
      });

      it('should handle null and undefined', () => {
        expect(shouldFallbackToCodex(null)).toBe(false);
        expect(shouldFallbackToCodex(undefined)).toBe(false);
      });

      it('should handle non-error objects by stringifying', () => {
        expect(shouldFallbackToCodex({ code: 429 })).toBe(false);
        expect(shouldFallbackToCodex(429)).toBe(true);
      });
    });
  });

  describe('isAbortError', () => {
    it('should return true for Error with name "AbortError"', () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      expect(isAbortError(abortError)).toBe(true);
    });

    it('should return true for objects with name "AbortError"', () => {
      expect(isAbortError({ name: 'AbortError', message: 'aborted' })).toBe(true);
    });

    it('should return false for regular Error objects', () => {
      expect(isAbortError(new Error('Some error'))).toBe(false);
      expect(isAbortError(new TypeError('Type error'))).toBe(false);
    });

    it('should return false for errors with other names', () => {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      expect(isAbortError(error)).toBe(false);
    });

    it('should return false for null and undefined', () => {
      expect(isAbortError(null)).toBe(false);
      expect(isAbortError(undefined)).toBe(false);
    });

    it('should return false for strings', () => {
      expect(isAbortError('AbortError')).toBe(false);
    });

    it('should return false for objects without name property', () => {
      expect(isAbortError({ message: 'error' })).toBe(false);
      expect(isAbortError({})).toBe(false);
    });
  });
});
