import { IsIn, IsString } from 'class-validator';

// Corps de POST /payouts/decision (public, soumis par la page HTML du mail équipe).
export class PayoutDecisionDto {
  @IsString()
  token: string;

  @IsIn(['confirm', 'reject'], { message: 'Décision invalide.' })
  decision: 'confirm' | 'reject';
}
