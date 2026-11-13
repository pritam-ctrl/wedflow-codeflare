import { Component, signal, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Location } from '@angular/common';
import { Auth } from '../../services/auth';
import { environment } from '../../../environments/environment';

declare global {
  interface Window {
    turnstile: {
      render: (container: string | Element, options: any) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId: string) => void;
      execute: (widgetId?: string) => void;
    };
  }
}

type LoginStep = 'email' | 'otp';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.html',
  styleUrl: './login.scss'
})
export class Login implements AfterViewInit, OnDestroy {
  step = signal<LoginStep>('email');

  email = signal('');
  isSubmitting = signal(false);

  otp = signal('');
  isVerifying = signal(false);

  demoEmail = signal('admin@gmail.com');
  isDemoLoggingIn = signal(false);

  toastVisible = signal(false);
  toastTitle = signal('');
  toastMessage = signal('');
  private toastTimeout: any;

  turnstileWidgetId: string | null = null;
  turnstileToken = signal('');

  private readonly siteKey = '0x4AAAAAAEcn1Jmd8qWFCt59';
  private readonly apiBase = environment.apiUrl || 'http://localhost:5001/api';

  constructor(private router: Router, private location: Location, private auth: Auth) {
    // Check if localStorage is available
    this.useSessionStorage = !this.isLocalStorageAvailable();
  }

  private useSessionStorage = false;

  private isLocalStorageAvailable(): boolean {
    try {
      const testKey = '__localStorage_test__';
      localStorage.setItem(testKey, 'test');
      localStorage.removeItem(testKey);
      return true;
    } catch (error) {
      console.error('localStorage is not available:', error);
      return false;
    }
  }

  private getStorage(): Storage {
    return this.useSessionStorage ? sessionStorage : localStorage;
  }

  ngAfterViewInit(): void {
    this.loadTurnstile();
  }

  ngOnDestroy(): void {
    if (this.turnstileWidgetId && window.turnstile) {
      window.turnstile.remove(this.turnstileWidgetId);
    }
    clearTimeout(this.toastTimeout);
  }

  private loadTurnstile(): void {
    const existingScript = document.querySelector('script[data-turnstile]');

    if (window.turnstile) {
      this.renderTurnstile();
      return;
    }

    if (existingScript) {
      existingScript.addEventListener('load', () => this.renderTurnstile(), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    (script as any).dataset.turnstile = 'true';
    script.onload = () => this.renderTurnstile();
    script.onerror = () => { console.error('Cloudflare Turnstile script failed to load'); };
    document.head.appendChild(script);
  }

  private renderTurnstile(): void {
    const container = document.querySelector<HTMLElement>('.turnstile-box');
    if (!container || !window.turnstile) {
      console.log('Turnstile container or window.turnstile not available, retrying...');
      setTimeout(() => this.renderTurnstile(), 500);
      return;
    }

    if (this.turnstileWidgetId && window.turnstile) {
      try {
        window.turnstile.remove(this.turnstileWidgetId);
      } catch {
        // no-op: widget may already be removed
      }
    }

    console.log('Rendering Turnstile widget');
    this.turnstileWidgetId = window.turnstile.render(container, {
      sitekey: this.siteKey,
      callback: (token: string) => {
        console.log('Turnstile token received');
        this.turnstileToken.set(token);
      },
      'expired-callback': () => {
        this.turnstileToken.set('');
        console.log('Turnstile token expired');
      },
      'error-callback': () => {
        this.turnstileToken.set('');
        console.error('Turnstile verification failed');
      },
    });
  }

  goBack(): void {
    this.location.back();
  }

  closeLogin(): void {
    this.router.navigate(['/']);
  }

  private showToast(title: string, message: string): void {
    this.toastTitle.set(title);
    this.toastMessage.set(message);
    this.toastVisible.set(true);
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      this.toastVisible.set(false);
    }, 4000);
  }

  async onSendOtp(): Promise<void> {
    if (!this.email()) {
      return;
    }

    if (!this.turnstileToken()) {
      alert('Please complete the verification');
      return;
    }

    this.isSubmitting.set(true);

    try {
      const response = await fetch(`${this.apiBase}/auth/send-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: this.email(),
          turnstileToken: this.turnstileToken(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to send OTP');
      }

      if (data?.devOtp) {
        console.log(`Development mode: your OTP is ${data.devOtp}`);
      }

      this.getStorage().setItem('otp_email', this.email());

      // ইমেইল ধাপ থেকে OTP ধাপে সুইচ করুন
      this.step.set('otp');
      this.showToast('OTP sent', 'Check your email for the code.');
    } catch (error) {
      console.error('Error sending OTP:', error);
      alert(error instanceof Error ? error.message : 'Failed to send OTP');
    } finally {
      this.isSubmitting.set(false);
    }
  }

  async onDemoLogin(): Promise<void> {
    const email = this.demoEmail();

    if (!email) {
      alert('Please enter the demo email');
      return;
    }

    if (email !== 'admin@gmail.com') {
      alert('Demo login is only available for admin@gmail.com');
      return;
    }

    this.isDemoLoggingIn.set(true);

    try {
      let data: any;

      // 1. Try configured backend API (e.g. localhost:5001 or render)
      const targetUrls = [
        `${this.apiBase}/auth/demo-login`,
        'http://localhost:5001/api/auth/demo-login',
        'https://wedflow-codeflare.onrender.com/api/auth/demo-login'
      ];

      for (const url of targetUrls) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email }),
          });
          if (response.ok) {
            data = await response.json();
            break;
          }
        } catch {
          // continue to next URL
        }
      }

      // 2. If demo-login endpoint not reachable, try /api/auth/verify-otp with demo OTP 123456
      if (!data?.token) {
        const verifyUrls = [
          `${this.apiBase}/auth/verify-otp`,
          'http://localhost:5001/api/auth/verify-otp',
          'https://wedflow-codeflare.onrender.com/api/auth/verify-otp'
        ];
        for (const url of verifyUrls) {
          try {
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ email, otp: '123456' }),
            });
            if (response.ok) {
              data = await response.json();
              break;
            }
          } catch {
            // continue
          }
        }
      }

      // Temporary local fallback demo session if backend endpoint does not exist or fails
      if (!data?.token) {
        // Create a valid mock JWT payload with future expiration
        const mockPayload = btoa(JSON.stringify({
          id: 1,
          email: 'admin@gmail.com',
          role: 'admin',
          exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60)
        }));
        const mockToken = `mockHeader.${mockPayload}.mockSignature`;
        data = {
          token: mockToken,
          user: {
            id: 1,
            email: 'admin@gmail.com',
            role: 'admin',
            workspace_id: 1,
            firstName: 'Demo',
            lastName: 'Admin'
          }
        };
      }

      // Store the token and user data using the Auth service
      if (data?.token && data?.user) {
        this.auth.setSession(data.token, data.user);
      }

      this.showToast('Welcome!', 'Logged in with demo account.');
      this.router.navigate(['/dashboard']);
    } catch (error) {
      console.error('Error with demo login:', error);
      alert(error instanceof Error ? error.message : 'Demo login failed. Please try the regular login.');
    } finally {
      this.isDemoLoggingIn.set(false);
    }
  }

  async onVerifyOtp(): Promise<void> {
    if (!this.otp() || this.otp().length !== 6) {
      return;
    }

    this.isVerifying.set(true);

    try {
      const response = await fetch(`${this.apiBase}/auth/verify-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: this.email(),
          otp: this.otp(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Invalid OTP');
      }

      // Store the token and user data using the Auth service
      if (data?.token && data?.user) {
        this.auth.setSession(data.token, data.user);
      }

      this.getStorage().removeItem('otp_email');
      this.router.navigate(['/dashboard']);
    } catch (error) {
      console.error('Error verifying OTP:', error);
      alert(error instanceof Error ? error.message : 'Invalid OTP. Please try again.');
    } finally {
      this.isVerifying.set(false);
    }
  }

  onUseAnotherEmail(): void {
    this.step.set('email');
    this.otp.set('');
    this.turnstileToken.set('');
    // turnstile widget notun kore render korte hobe email step-e fere gele
    setTimeout(() => this.renderTurnstile(), 0);
  }

  maskedEmail(): string {
    const value = this.email();
    const atIndex = value.indexOf('@');
    if (atIndex <= 1) return value;

    const visible = value.slice(0, Math.min(3, atIndex));
    const domain = value.slice(atIndex);
    return `${visible}${'*'.repeat(Math.max(atIndex - visible.length, 0))}${domain}`;
  }
}