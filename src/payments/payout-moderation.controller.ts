import { Body, Controller, Get, Header, Post, Query } from '@nestjs/common';
import { PayoutDecisionDto } from './dto/payout-decision.dto';
import { PayoutModerationService } from './payout-moderation.service';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// PUBLIC (aucun guard) : l'équipe Vybe décide depuis le mail. La page GET affiche
// un bouton qui POST (évite qu'un prefetch du client mail décide tout seul).
@Controller('payouts')
export class PayoutModerationController {
  constructor(private readonly moderation: PayoutModerationService) {}

  @Get('decision')
  @Header('Content-Type', 'text/html')
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  )
  decisionPage(
    @Query('token') token: string,
    @Query('decision') decision: string,
  ): string {
    const safe = decision === 'reject' ? 'reject' : 'confirm';
    const label = safe === 'confirm' ? 'CONFIRMER' : 'REJETER';
    const color = safe === 'confirm' ? '#1db954' : '#e0245e';
    return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><title>Retrait Vybe</title></head>
<body style="font-family:Arial,sans-serif;background:#0d0d0d;color:#fff;text-align:center;padding:60px;">
  <h1>Confirmer : ${label}</h1>
  <p>Confirmez votre décision sur cette réclamation de retrait.</p>
  <form method="POST" action="/payouts/decision">
    <input type="hidden" name="token" value="${escapeHtml(token ?? '')}"/>
    <input type="hidden" name="decision" value="${safe}"/>
    <button type="submit" style="padding:14px 28px;border:none;border-radius:10px;font-weight:700;cursor:pointer;background:${color};color:#fff;">
      Confirmer : ${label}
    </button>
  </form>
</body></html>`;
  }

  @Post('decision')
  async decisionPost(@Body() dto: PayoutDecisionDto) {
    return this.moderation.decide(dto.token, dto.decision);
  }
}
