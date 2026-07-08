import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import * as bcrypt from 'bcrypt';
import { VerifyIdentifierDto } from './dto/verify-identifier.dto';
import { ChangeIdentifierDto } from './dto/change-identifier.dto';

import * as fs from 'fs';
import * as path from 'path';
import { JwtService } from '@nestjs/jwt';
import { OtpService } from 'src/otp/otp.service';

const MAX_UPDATES_PER_MONTH = 2;

// Liste des noms/prénoms interdits, chargée depuis un fichier texte
const filePath =
  process.env.NODE_ENV === 'production'
    ? path.resolve('dist/text/banned_usernames.txt')
    : path.resolve('src/text/banned_usernames.txt');

const RESERVED_NAMES: string[] = fs
  .readFileSync(filePath, 'utf-8')
  .split('\n') //decoupe en tableau ligne par ligne
  .map((line) => line.trim().toLowerCase()) //supprime espaces + lowercase
  .filter((line) => line.length > 0);

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly otpService: OtpService,
  ) {}

  findAll() {
    return `This action returns all users`;
  }

  // Profil de l'utilisateur connecté (champs publics uniquement —
  // jamais le hashedPassword ni les compteurs internes).
  async findMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        firstname: true,
        lastname: true,
        avatarUrl: true,
        role: true,
        emailVerified: true,
        phoneVerified: true,
        createdAt: true,
      },
    });
    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }
    return user;
  }

  findOne(id: number) {
    return `This action returns a #${id} user`;
  }

  async update(userId: string, dto: UpdateUserDto) {
    //body vide ?
    const hashChanges = Object.values(dto).some((v) => v !== undefined);
    if (!hashChanges) {
      throw new BadRequestException('Aucune modification fournie.');
    }

    //utilisateur existe
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }
    //limite : 2 modifications par mois

    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    //meme moi et meme année -> on verifie le compteur
    const sameMonthYear =
      user.profileUpdateMonth === currentMonth &&
      user.profileUpdateYear === currentYear;

    const updateCount = sameMonthYear ? user.profileUpdateCount : 0;

    if (updateCount >= MAX_UPDATES_PER_MONTH) {
      throw new ForbiddenException(
        `Vous avez atteint la limite de ${MAX_UPDATES_PER_MONTH} modification par mois`,
      );
    }

    // Refus des noms/prénoms interdits
    const invalidName =
      (dto.firstName !== undefined &&
        RESERVED_NAMES.includes(dto.firstName.trim().toLowerCase())) ||
      (dto.lastName !== undefined &&
        RESERVED_NAMES.includes(dto.lastName.trim().toLowerCase()));
    if (invalidName) {
      throw new BadRequestException(
        "Le nom que vous avez utilisé n'est pas valide, veuillez en saisir un autre.",
      );
    }

    //construction dynamyque de l'objet data
    const data: Record<string, unknown> = {
      // Mise à jour du compteur
      profileUpdatedAt: now,
      profileUpdateCount: updateCount + 1,
      profileUpdateMonth: currentMonth,
      profileUpdateYear: currentYear,
    };

    if (dto.firstName !== undefined) data.firstname = dto.firstName;
    if (dto.lastName !== undefined) data.lastname = dto.lastName;
    if (dto.avatarUrl !== undefined) data.avatarUrl = dto.avatarUrl;

    // ── 7. Mise à jour en base ────────────────────────────────────
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        firstname: true,
        lastname: true,
        avatarUrl: true,
        email: true,
        phone: true,
        role: true,
        profileUpdatedAt: true,
        // On expose le compteur pour que le frontend puisse afficher
        // "Il vous reste X modification(s) ce mois-ci"
        profileUpdateCount: true,
        createdAt: true,
      },
    });

    return {
      message: `Profil mis à jour. Il vous reste ${MAX_UPDATES_PER_MONTH - (updateCount + 1)} modification(s) ce mois-ci.`,
      user: updated,
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    // Utilisateur existe ?
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }

    // l'utilisateur a un password ?
    if (!user.hashedPassword) {
      throw new ForbiddenException('Aucun mot de passe associé à ce compte.');
    }
    // verification de l'ancien password
    const isMatch = await bcrypt.compare(
      dto.currentPassword,
      user.hashedPassword,
    );

    if (!isMatch) {
      throw new UnauthorizedException('Mot de passe actuel incorrect.');
    }
    //newPassword ≠ confirmPassword → erreu
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException(
        'La confirmation ne correspond pas au nouveau mot de passe.',
      );
    }
    //Nouveau password identique à l'ancien → refus
    const isSameAsOld = await bcrypt.compare(
      dto.newPassword,
      user.hashedPassword,
    );

    if (isSameAsOld) {
      throw new BadRequestException(
        "Le nouveau mot de passe doit être différent de l'ancien.",
      );
    }
    // Hasher et sauvegarder
    const newHash = await bcrypt.hash(dto.newPassword, 12);

    await this.prisma.user.update({
      where: { id: userId },
      data: { hashedPassword: newHash },
    });

    return { message: 'Mot de passe mis à jour avec succès.' };
  }

  async requestIdentifierChange(userId: string, dto: ChangeIdentifierDto) {
    // newEmail et newPhone tous les deux fournis -> refus
    if (dto.newEmail && dto.newPhone) {
      throw new BadRequestException(
        'Fournissez soit un email, soit un numéro de téléphone, pas les deux.',
      );
    }
    // rien fourni -> refus
    if (!dto.newEmail && !dto.newPhone) {
      throw new BadRequestException(
        'Fournissez un email ou un numéro de téléphone.',
      );
    }
    // Utilisateur existe ?
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }

    // Le compte possède-t-il l'identifiant qu'on veut changer ?
    if (dto.newEmail && !user.email) {
      throw new BadRequestException(
        "Ce compte n'est pas associé à une adresse email.",
      );
    }

    if (dto.newPhone && !user.phone) {
      throw new BadRequestException(
        "Ce compte n'est pas associé à un numéro de téléphone.",
      );
    }

    //le nouvel identifiant est identique à l'ancien -> refus
    if (dto.newEmail && dto.newEmail === user.email) {
      throw new BadRequestException(
        "La nouvelle adresse email doit être différente de l'ancienne.",
      );
    }

    if (dto.newPhone && dto.newPhone === user.phone) {
      throw new BadRequestException(
        "Le nouveau numéro doit être différent de l'ancien.",
      );
    }

    //nouvel identifiant déjà pris par un autre compte
    const newIdentifier = (dto.newEmail ?? dto.newPhone) as string;

    const alreadyExists = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: newIdentifier }, { phone: newIdentifier }],
      },
    });
    if (alreadyExists) {
      await this.otpService.sendPhoneOtp(newIdentifier);
    }

    //generer le temptoken
    //on encode le userId + le nouvel identifiant
    //(pour savoir quoi mettre à jour au moment de la vérification)
    const temptoken = this.jwtService.sign(
      {
        sub: userId,
        newIdentifier,
        type: 'identifier-change',
      },
      { expiresIn: '10m' },
    );
    return {
      message: `Un code de verification a été envoyé sur ${newIdentifier}.`,
      temptoken,
    };
  }

  async verifyIdentifierChange(
    userId: string,
    dto: VerifyIdentifierDto,
    tempToken: string,
  ) {
    //verifier et décoder le tempToken
    let payload: { sub: string; newIdentifier: string; type: string };

    try {
      payload = this.jwtService.verify(tempToken);
    } catch {
      throw new UnauthorizedException('Token invalide ou expiré.');
    }

    //le token appartient à l'utilisateur
    if (payload.sub !== userId) {
      throw new ForbiddenException('Token non autorisé.');
    }

    // verifier si c'est bien un token de changement d'identifiant
    if (payload.sub !== userId) {
      throw new ForbiddenException('Type de token non autorisé.');
    }

    //verifier l'otp (lève une exception si le code est invalide ou expiré)
    await this.otpService.verifyOtp(payload.newIdentifier, dto.otp);

    // Déterminer quel champ mettre à jour
    // On détecte si c'est un email ou un phone via le format
    const isEmail = payload.newIdentifier.includes('@');

    const data = isEmail
      ? { email: payload.newIdentifier }
      : { phone: payload.newIdentifier };

    // Mettre à jour en base
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        phone: true,
        firstname: true,
        lastname: true,
        role: true,
      },
    });

    return {
      message: 'Identifiant mis à jour avec succès.',
      user: updated,
    };
  }

  // ─── Suppression de compte (OTP + soft delete réversible 2 semaines) ──────────

  async requestAccountDeletion(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }

    // Un compte n'est associé qu'à un seul canal (email OU téléphone) : on envoie
    // le code de sécurité sur celui qui est renseigné.
    const identifier = user.email ?? user.phone;
    if (!identifier) {
      throw new BadRequestException(
        'Aucun email ni numéro de téléphone associé à ce compte.',
      );
    }

    if (user.email) {
      await this.otpService.sendAccountDeletionEmailOtp(user.email);
    } else {
      await this.otpService.sendAccountDeletionPhoneOtp(user.phone!);
    }

    // Token temporaire typé : ne sert qu'à confirmer cette suppression précise.
    const tempToken = this.jwtService.sign(
      { sub: userId, type: 'account-deletion' },
      { expiresIn: '10m' },
    );

    return {
      message:
        'Un code de sécurité vous a été envoyé pour confirmer la suppression de votre compte.',
      tempToken,
    };
  }

  async verifyAccountDeletion(userId: string, otp: string, tempToken: string) {
    // 1. Vérifier et décoder le tempToken
    let payload: { sub: string; type: string };
    try {
      payload = this.jwtService.verify(tempToken);
    } catch {
      throw new UnauthorizedException('Token invalide ou expiré.');
    }

    // 2. Le token doit être un token de suppression et appartenir à l'utilisateur courant
    if (payload.type !== 'account-deletion') {
      throw new ForbiddenException('Type de token non autorisé.');
    }
    if (payload.sub !== userId) {
      throw new ForbiddenException('Token non autorisé.');
    }

    // 3. Charger l'utilisateur et retrouver l'identifiant ciblé par l'OTP
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }
    if (!user.isValid) {
      throw new BadRequestException(
        'Ce compte est déjà en attente de suppression.',
      );
    }

    const identifier = user.email ?? user.phone;
    if (!identifier) {
      throw new BadRequestException(
        'Aucun email ni numéro de téléphone associé à ce compte.',
      );
    }

    // 4. Vérifier l'OTP (lève une exception si invalide/expiré)
    await this.otpService.verifyOtp(identifier, otp);

    // 5. Soft delete : on invalide le compte et on démarre le délai de grâce de 2 semaines
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        isValid: false,
        deletionRequestedAt: new Date(),
      },
    });

    return {
      message:
        'Votre compte a été désactivé. Il sera définitivement supprimé dans deux semaines. ' +
        'Vous pouvez revenir en arrière en contactant le support pendant ce délai.',
    };
  }

  remove(id: number) {
    return `This action removes a #${id} user`;
  }
}
