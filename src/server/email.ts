/**
 * Outbound email, kept deliberately thin (issue #104): this is a one-call
 * wrapper around the Resend API, not a templating system. `AppConfig`
 * ultimately holds a plain `SendEmail` function (not a class instance, and
 * not the Resend client itself), so tests -- and any future email provider --
 * can inject any implementation without ever touching Resend or making a
 * real network call.
 */

export interface SendEmailInput {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
}

export type SendEmail = (input: SendEmailInput) => Promise<void>;

/**
 * Builds a `SendEmail` backed by a single `fetch` call to Resend's send-email
 * endpoint. Throws a descriptive `Error` (including the response status) on
 * any non-ok response, rather than swallowing a delivery failure -- callers
 * (see `POST /api/signup` in `app.ts`) deliberately let this propagate to the
 * app's existing error-mapping middleware instead of catching it locally.
 */
export function createResendSender(apiKey: string, fromAddress: string): SendEmail {
  return async function sendEmail(input: SendEmailInput): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: input.to,
        subject: input.subject,
        html: input.html,
      }),
    });

    if (!res.ok) {
      throw new Error(`Resend email send failed with status ${res.status}`);
    }
  };
}
