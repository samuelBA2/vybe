import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import sgMail from '@sendgrid/mail';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MailService {
  private logger = new Logger(MailService.name);

  constructor() {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
    this;
  }

  async sendOtp(to: string, otp: string, expiresInMinutes = 10): Promise<void> {
    const msg = {
      to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL!,
        name: process.env.SENDGRID_FROM_NAME || 'Vybe Team',
      },
      subject: 'Votre code de vérification Vybe',
      text: `Votre code de vérification Vybe est : ${otp}. Il expire dans ${expiresInMinutes} minutes.`,
      html: `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Vybe – Vérification</title>
</head>
<body style="margin:0;padding:0;background-color:#0d0d0d;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0d0d0d;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color:#141414;border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.6);">
          
          <!-- HEADER avec dégradé -->
          <tr>
            <td align="center" style="background:linear-gradient(135deg,#7B2FF7,#F107A3);padding:40px 40px 32px;">
              <!-- Logo SVG inline -->
              <svg width="120" height="48" viewBox="0 0 300 100" xmlns="http://www.w3.org/2000/svg">
                <text x="10" y="78" font-family="Arial Black, sans-serif" font-size="88" font-weight="900"
                  fill="white" letter-spacing="-2">Vybe</text>
                <!-- Smile arrow -->
                <path d="M 30 88 Q 155 115 270 88" stroke="white" stroke-width="5" fill="none" stroke-linecap="round"/>
                <polygon points="265,82 275,88 263,94" fill="white"/>
              </svg>
              <p style="color:rgba(255,255,255,0.85);font-size:14px;margin:12px 0 0;letter-spacing:1px;text-transform:uppercase;">
                L'expérience événementielle réinventée
              </p>
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="padding:40px 48px 32px;">
              <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0 0 12px;">
                Vérifiez votre identité
              </h1>
              <p style="color:#aaaaaa;font-size:15px;line-height:1.7;margin:0 0 32px;">
                Utilisez le code ci-dessous pour confirmer votre accès à Vybe. 
                Ce code est valable pendant <strong style="color:#ffffff;">${expiresInMinutes} minutes</strong>.
              </p>

              <!-- OTP BOX -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                <tr>
                  <td align="center">
                    <div style="display:inline-block;background:linear-gradient(135deg,#7B2FF7,#F107A3);border-radius:12px;padding:2px;">
                      <div style="background:#1e1e1e;border-radius:10px;padding:20px 48px;">
                        <span style="font-size:42px;font-weight:900;letter-spacing:12px;color:#ffffff;font-family:'Courier New',monospace;">
                          ${otp}
                        </span>
                      </div>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- WARNING -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                <tr>
                  <td style="background:#1e1e1e;border-left:3px solid #F107A3;border-radius:0 8px 8px 0;padding:14px 18px;">
                    <p style="color:#888888;font-size:13px;margin:0;line-height:1.6;">
                      🔒 <strong style="color:#cccccc;">Ne partagez jamais ce code.</strong> 
                      L'équipe Vybe ne vous demandera jamais votre code de vérification.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="color:#555555;font-size:13px;line-height:1.6;margin:0;">
                Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email. 
                Votre compte reste sécurisé.
              </p>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="background:#0d0d0d;padding:24px 48px;border-top:1px solid #222222;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="color:#444444;font-size:12px;margin:0;line-height:1.6;">
                      © ${new Date().getFullYear()} Vybe · Tous droits réservés<br/>
                      <a href="#" style="color:#7B2FF7;text-decoration:none;">Politique de confidentialité</a>
                      &nbsp;·&nbsp;
                      <a href="#" style="color:#7B2FF7;text-decoration:none;">Nous contacter</a>
                    </p>
                  </td>
                  <td align="right">
                    <p style="color:#333333;font-size:11px;margin:0;font-style:italic;">
                      Vivez chaque moment.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    };

    try {
      await sgMail.send(msg);
      this.logger.log(`OTP envoyé à ${to}`);
    } catch (error) {
      this.logger.error(
        `Erreur lors de l'envoi de l'OTP à ${to}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        "Impossible d'envoyer le code de vérification. Veuillez réessayer plus tard.",
      );
    }
  }

  async sendAccountDeletionOtp(
    to: string,
    otp: string,
    expiresInMinutes = 10,
  ): Promise<void> {
    const intro =
      'Voici le code de sécurité que vous devez saisir pour poursuivre le processus de suppression de votre compte. ' +
      "Sachez qu'après avoir supprimé votre compte, il restera stocké en base de données pendant un délai de deux semaines, " +
      'pour vous permettre de revenir en arrière si vous le souhaitez.';

    const msg = {
      to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL!,
        name: process.env.SENDGRID_FROM_NAME || 'Vybe Team',
      },
      subject: 'Suppression de votre compte Vybe',
      text: `${intro} Votre code de sécurité : ${otp}. Il expire dans ${expiresInMinutes} minutes.`,
      html: `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Vybe – Suppression de compte</title>
</head>
<body style="margin:0;padding:0;background-color:#0d0d0d;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0d0d0d;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color:#141414;border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.6);">

          <!-- HEADER avec dégradé -->
          <tr>
            <td align="center" style="background:linear-gradient(135deg,#7B2FF7,#F107A3);padding:40px 40px 32px;">
              <svg width="120" height="48" viewBox="0 0 300 100" xmlns="http://www.w3.org/2000/svg">
                <text x="10" y="78" font-family="Arial Black, sans-serif" font-size="88" font-weight="900"
                  fill="white" letter-spacing="-2">Vybe</text>
                <path d="M 30 88 Q 155 115 270 88" stroke="white" stroke-width="5" fill="none" stroke-linecap="round"/>
                <polygon points="265,82 275,88 263,94" fill="white"/>
              </svg>
              <p style="color:rgba(255,255,255,0.85);font-size:14px;margin:12px 0 0;letter-spacing:1px;text-transform:uppercase;">
                L'expérience événementielle réinventée
              </p>
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="padding:40px 48px 32px;">
              <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0 0 12px;">
                Confirmez la suppression de votre compte
              </h1>
              <p style="color:#aaaaaa;font-size:15px;line-height:1.7;margin:0 0 32px;">
                ${intro}
                Ce code est valable pendant <strong style="color:#ffffff;">${expiresInMinutes} minutes</strong>.
              </p>

              <!-- OTP BOX -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                <tr>
                  <td align="center">
                    <div style="display:inline-block;background:linear-gradient(135deg,#7B2FF7,#F107A3);border-radius:12px;padding:2px;">
                      <div style="background:#1e1e1e;border-radius:10px;padding:20px 48px;">
                        <span style="font-size:42px;font-weight:900;letter-spacing:12px;color:#ffffff;font-family:'Courier New',monospace;">
                          ${otp}
                        </span>
                      </div>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- WARNING -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                <tr>
                  <td style="background:#1e1e1e;border-left:3px solid #F107A3;border-radius:0 8px 8px 0;padding:14px 18px;">
                    <p style="color:#888888;font-size:13px;margin:0;line-height:1.6;">
                      🔒 <strong style="color:#cccccc;">Ne partagez jamais ce code.</strong>
                      L'équipe Vybe ne vous demandera jamais votre code de sécurité.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="color:#555555;font-size:13px;line-height:1.6;margin:0;">
                Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email
                et changez votre mot de passe. Votre compte reste sécurisé.
              </p>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="background:#0d0d0d;padding:24px 48px;border-top:1px solid #222222;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="color:#444444;font-size:12px;margin:0;line-height:1.6;">
                      © ${new Date().getFullYear()} Vybe · Tous droits réservés<br/>
                      <a href="#" style="color:#7B2FF7;text-decoration:none;">Politique de confidentialité</a>
                      &nbsp;·&nbsp;
                      <a href="#" style="color:#7B2FF7;text-decoration:none;">Nous contacter</a>
                    </p>
                  </td>
                  <td align="right">
                    <p style="color:#333333;font-size:11px;margin:0;font-style:italic;">
                      Vivez chaque moment.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    };

    try {
      await sgMail.send(msg);
      this.logger.log(`Code de suppression de compte envoyé à ${to}`);
    } catch (error) {
      this.logger.error(
        `Erreur lors de l'envoi du code de suppression à ${to}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        "Impossible d'envoyer le code de sécurité. Veuillez réessayer plus tard.",
      );
    }
  }

  findAll() {
    return `This action returns all mail`;
  }

  findOne(id: number) {
    return `This action returns a #${id} mail`;
  }

  // update(id: number, updateMailDto: UpdateMailDto) {
  //   return `This action updates a #${id} mail`;
  // }

  remove(id: number) {
    return `This action removes a #${id} mail`;
  }
}
