import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { Config } from "../config.js";

// Email to and from suppliers: sends over SMTP, reads unread replies over IMAP.

export interface InboundEmail {
  from: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
  /** Returns unread emails and marks them as read. */
  fetchUnread(): Promise<InboundEmail[]>;
}

export class SmtpImapMailer implements Mailer {
  private readonly transport;

  constructor(private readonly config: Config["email"]) {
    this.transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: { user: config.user, pass: config.password },
    });
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    await this.transport.sendMail({ from: this.config.from, to, subject, text });
  }

  async fetchUnread(): Promise<InboundEmail[]> {
    const client = new ImapFlow({
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: true,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
    });
    await client.connect();
    const emails: InboundEmail[] = [];
    const lock = await client.getMailboxLock("INBOX");
    try {
      const unseen = await client.search({ seen: false }, { uid: true });
      if (unseen && unseen.length > 0) {
        for await (const message of client.fetch(unseen, { source: true }, { uid: true })) {
          if (!message.source) continue;
          const parsed = await simpleParser(message.source);
          emails.push({
            from: parsed.from?.value[0]?.address ?? "",
            subject: parsed.subject ?? "",
            text: parsed.text ?? "",
          });
        }
        await client.messageFlagsAdd(unseen, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
      await client.logout();
    }
    return emails;
  }
}
