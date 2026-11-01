/**
 * Email send helper.
 *
 * When RESEND_API_KEY is set, dispatches transactional emails via Resend.
 * Otherwise logs the payload to stdout so the demo flow still produces visible
 * evidence of "the email would have gone out".
 *
 * Templates are inline (no template engine) — keeps the dependency surface
 * tiny and the payloads auditable.
 */

import { Resend } from 'resend';
import { env, features } from './env.js';
import { log } from './log.js';

const client: Resend | null = features.resend && env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
if (client) log.info('email: resend client ready');

export type EmailTemplate = 'otp' | 'claim' | 'digest' | 'welcome' | 'fulfillment';

export interface EmailData {
  otp: { code: string; expiresInMinutes: number };
  claim: { senderName: string; amountUsd: number; claimUrl: string };
  digest: { agentName: string; spentUsd: number; topEndpoint: string };
  welcome: { name: string };
  fulfillment: { offerTitle: string; kind: 'url' | 'message' | 'none'; value: string | null; amountUsd: number };
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  reason?: string;
}

export async function sendEmail<T extends EmailTemplate>(
  to: string,
  template: T,
  data: EmailData[T],
): Promise<SendEmailResult> {
  const rendered = render(template, data);
  if (!client) {
    log.info({ to, template, subject: rendered.subject }, 'email.demo: would send');
    return { ok: true, id: 'demo' };
  }
  try {
    const result = await client.emails.send({
      from: env.RESEND_FROM,
      to: [to],
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (result.error) {
      log.warn({ to, template, err: result.error.message }, 'email: resend rejected');
      return { ok: false, reason: result.error.message };
    }
    log.info({ to, template, id: result.data?.id }, 'email: sent');
    return { ok: true, id: result.data?.id };
  } catch (e) {
    log.warn({ to, template, err: e instanceof Error ? e.message : String(e) }, 'email: send failed');
    return { ok: false, reason: e instanceof Error ? e.message : 'unknown' };
  }
}

function render<T extends EmailTemplate>(template: T, data: EmailData[T]): { subject: string; html: string; text: string } {
  switch (template) {
    case 'otp': {
      const d = data as EmailData['otp'];
      const subject = `Your MAZE code: ${d.code}`;
      const text = `Use code ${d.code} to sign in to MAZE.\n\nThis code expires in ${d.expiresInMinutes} minutes.\nIf you didn't try to sign in, ignore this email.`;
      const html = `<div style="font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;color:#0A0A0C;background:#F5F6FA;padding:32px;line-height:1.5">
        <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;padding:32px">
          <div style="font-size:20px;font-weight:600;letter-spacing:-0.01em">MAZE</div>
          <div style="margin-top:24px;font-size:14px;color:#6B7280">Your sign-in code</div>
          <div style="margin-top:8px;font-size:36px;font-weight:600;letter-spacing:0.2em;color:#FF6A1A">${d.code}</div>
          <div style="margin-top:24px;font-size:13px;color:#6B7280">Expires in ${d.expiresInMinutes} minutes. If you didn't try to sign in, ignore this email.</div>
        </div>
      </div>`;
      return { subject, html, text };
    }
    case 'claim': {
      const d = data as EmailData['claim'];
      const subject = `${d.senderName} sent you $${d.amountUsd.toFixed(2)} on MAZE`;
      const text = `${d.senderName} sent you $${d.amountUsd.toFixed(2)}.\n\nClaim it here: ${d.claimUrl}\n\nIf the link expires, ${d.senderName} can resend it from the MAZE app.`;
      const html = `<div style="font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;color:#0A0A0C;background:#F5F6FA;padding:32px;line-height:1.5">
        <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;padding:32px">
          <div style="font-size:20px;font-weight:600;letter-spacing:-0.01em">MAZE</div>
          <div style="margin-top:24px;font-size:14px;color:#6B7280">${d.senderName} sent you</div>
          <div style="margin-top:8px;font-size:36px;font-weight:600;color:#FF6A1A">$${d.amountUsd.toFixed(2)}</div>
          <a href="${d.claimUrl}" style="display:inline-block;margin-top:24px;padding:12px 24px;background:#0A0A0C;color:#fff;text-decoration:none;border-radius:12px;font-size:14px;font-weight:500">Claim now</a>
        </div>
      </div>`;
      return { subject, html, text };
    }
    case 'digest': {
      const d = data as EmailData['digest'];
      const subject = `${d.agentName} · daily activity digest`;
      const text = `${d.agentName} spent $${d.spentUsd.toFixed(2)} today. Top endpoint: ${d.topEndpoint}.`;
      const html = `<div style="font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;color:#0A0A0C;padding:32px">
        <div style="font-size:20px;font-weight:600">MAZE · ${d.agentName}</div>
        <p style="font-size:14px;color:#6B7280">Today: <strong>$${d.spentUsd.toFixed(2)}</strong> · Top: ${d.topEndpoint}</p>
      </div>`;
      return { subject, html, text };
    }
    case 'welcome': {
      const d = data as EmailData['welcome'];
      const subject = `Welcome to MAZE, ${d.name}.`;
      const text = `Welcome to MAZE — one ledger for humans and agents.`;
      const html = `<div style="font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;color:#0A0A0C;padding:32px">
        <h1 style="font-size:24px">Welcome, ${d.name}.</h1>
        <p>One ledger for humans and agents.</p>
      </div>`;
      return { subject, html, text };
    }
    case 'fulfillment': {
      const d = data as EmailData['fulfillment'];
      const subject = `Your purchase: ${d.offerTitle}`;
      const amount = `$${d.amountUsd.toFixed(2)}`;
      let accessText: string;
      let accessHtml: string;
      if (d.kind === 'url' && d.value) {
        accessText = `Access your purchase here: ${d.value}`;
        accessHtml = `<a href="${d.value}" style="display:inline-block;margin-top:24px;padding:12px 24px;background:#0A0A0C;color:#fff;text-decoration:none;border-radius:12px;font-size:14px;font-weight:500">Access your purchase</a>`;
      } else if (d.kind === 'message' && d.value) {
        accessText = d.value;
        accessHtml = `<div style="margin-top:24px;padding:16px;background:#F5F6FA;border:1px solid #E5E7EB;border-radius:12px;font-size:14px;color:#0A0A0C;white-space:pre-wrap">${d.value}</div>`;
      } else {
        accessText = 'The seller will be in touch shortly.';
        accessHtml = `<div style="margin-top:24px;font-size:14px;color:#6B7280">The seller will be in touch shortly.</div>`;
      }
      const text = `Thanks for your purchase of ${d.offerTitle}.\n\nYour payment of ${amount} is confirmed.\n\n${accessText}`;
      const html = `<div style="font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;color:#0A0A0C;background:#F5F6FA;padding:32px;line-height:1.5">
        <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:16px;padding:32px">
          <div style="font-size:20px;font-weight:600;letter-spacing:-0.01em">MAZE</div>
          <div style="margin-top:24px;font-size:14px;color:#6B7280">Payment confirmed</div>
          <div style="margin-top:8px;font-size:24px;font-weight:600;color:#FF6A1A">${d.offerTitle}</div>
          <div style="margin-top:8px;font-size:14px;color:#6B7280">You paid <strong style="color:#0A0A0C">${amount}</strong>.</div>
          ${accessHtml}
        </div>
      </div>`;
      return { subject, html, text };
    }
    default: {
      const _: never = template;
      return { subject: 'MAZE', html: '', text: '' };
    }
  }
}
