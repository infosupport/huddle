import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs/operators';
import { AuthService } from '../services/auth.service';

// Elke API-call die 401 teruggeeft betekent dat de operator-sessie ontbreekt of
// verlopen is → de app-shell klapt terug naar het login-scherm. De /api/auth/*-
// calls laten we met rust (die sturen hun eigen status).
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  return next(req).pipe(
    tap({
      error: (err) => {
        if (err?.status === 401 && !req.url.includes('/api/auth/')) {
          auth.authenticated.set(false);
        }
      },
    }),
  );
};
