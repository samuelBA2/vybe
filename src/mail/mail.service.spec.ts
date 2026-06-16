import { Injectable } from "@nestjs/common";
import * as sgMail from "@sendgrid/mail";


@Injectable()
export class MailService {
  constructor() {
    if (!process.env.SENDGRID_API_KEY) {
      throw new Error("SENDGRID_API_KEY is not defined in environment variables");
    }
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  }
  
  async sendOtpEmail(to: string, code: string) {
    const msg = {
      to,
      from: 'samuelbakumbane0@gmail.com',
      subject: 'Votre code OTP pour Vybe',
      text: `Votre code OTP pour Vybe est : ${code}`,
      html: `<p>Votre code OTP pour Vybe est : <strong>${code}</strong></p>`,
    };

    await sgMail.send(msg);
  }
} 