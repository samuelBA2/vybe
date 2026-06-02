import { Injectable, UnauthorizedException, BadRequestException, ConflictException, Body, Req } from '@nestjs/common';
import { UpdateAuthDto } from './dto/update-auth.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { $Enums } from '@prisma/client';
import { RegisterEmailDto } from './dto/register-mail.dto';
import { RegisterPhoneDto } from './dto/register-phone.dto';
import { LoginEmailDto } from './dto/login-mail.dto';
import { VerifyOtpDto } from 'src/auth/dto/verify-otp.dto'
import { LoginPhoneDto } from './dto/login-phone.dto';
import { SmsService } from 'src/sms/sms.service';
import { Message } from 'twilio/lib/twiml/MessagingResponse';
import { ConfigService } from '@nestjs/config';
import { SendPhoneOtpDto } from './dto/send-phone-otp.dto';
import { SendEmailOtpDto } from './dto/send-mail-otp.dto';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { randomUUID } from 'crypto';

@Injectable()
  export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private smsService: SmsService,
    private config: ConfigService,
  ) {}

  // Method to sign JWT token partagé
  private signToken(payload: { sub: string; role: string }) {
  const secret = this.config.get<string>('JWT_SECRET')

  if (!secret) {
    throw new Error('JWT secret not configured')
  }
  return this.jwt.sign(payload, { secret, expiresIn: '1h' })
  }
//inscription par email
  async registerEmail(dto: RegisterEmailDto) {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } })
    if (exists) throw new ConflictException('Email already in use')

    const hashedPassword = await bcrypt.hash(dto.password, 10)
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phone: '',
        firstname: dto.firstName,
        lastname: dto.lastName,
        hashedPassword,
        role: $Enums.Role.ADMIN,
        emailVerified: false,
      },
    })

    return {message : 'verificcation email sent to '}
  } 
//connection par email
  async loginEmail(dto: LoginEmailDto) {
    const dummy_hash = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8z5rZ3i.1QyY9Vn0e7aPqFhXoG' // bcrypt hash de "password"

    const user = await this.prisma.user.findUnique({ where: { email: dto.email } })

    const hash = user?.hashedPassword ?? dummy_hash

    const valid = await bcrypt.compare(dto.password, hash)

    if (!user || !user.hashedPassword || !valid || !user.emailVerified) {
    throw new UnauthorizedException('Identifiants invalides')
  }
  

    return { token: this.signToken({ sub: user.id, role: user.role}) }
  }


async loginPhone(dto: LoginPhoneDto) {
    const dummy_hash = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8z5rZ3i.1QyY9Vn0e7aPqFhXoG' // bcrypt hash de "password"

    const user = await this.prisma.user.findUnique({ where: { phone: dto.phone } })

    const hash = user?.hashedPassword ?? dummy_hash

    const valid = await bcrypt.compare(dto.password, hash)
    
    if (!user || !user.hashedPassword || !valid || !user.phoneVerified) {
    throw new UnauthorizedException('Identifiants invalides')
  }

  return { token: this.signToken({ sub: user.id, role: user.role}) }
}  

//Connexion par téléphone : vérification du code OTP et création du compte si nécessaire
  async sendPhoneOtp(dto: SendPhoneOtpDto) {

    //verifier si le numéro est déjà associé à un compte

  const exists = await this.prisma.user.findUnique({ where: { phone: dto.phone } })
    if (exists) {
      await this.smsService.sendOtp(dto.phone, "Quelqu'un tente de s'inscrire avec votre numéro vybe. Si ce n'est pas vous, ignorez ce message.")

      return{
        message:"Un code de verification vous a été envoyé, si le numéro n'est pas associé à un compte vybe"
      }
    }

  const otp = await this.generateUniqueOtp()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5 min

  // upsert : crée l'entrée OTP si elle n'existe pas, la remplace sinon
  // (cas où l'utilisateur redemande un code avant expiration)
  await this.prisma.otpVerification.upsert({
    where: { phone: dto.phone },
    update: { otp, expiresAt },
    create: { phone: dto.phone, otp, expiresAt },
  })

  await this.smsService.sendOtp(dto.phone, `Votre code de verification vybe :${otp}`)

  return { message: 'Un code de verification vous a été envoyé' }
}

//send OTP par email
async sendEmailOtp(dto: SendEmailOtpDto) {
  const exists = await this.prisma.user.findUnique({ where: { email: dto.email } })
  if (exists) throw new ConflictException("Un code de verification vous a été envoyé, si l'email n'existe pas en base ")

  const otp = await this.generateUniqueOtp()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5 min

  await this.prisma.otpVerification.upsert({
    where: { email: dto.email }, // on utilise le champ "phone" pour stocker l'email dans la table OTP
    update: { otp, expiresAt },
    create: { phone: dto.email, otp, expiresAt },
  })

  // Simule l'envoi de l'email (await...)
  console.log(`OTP pour ${dto.email} : ${otp}`) //📝à remplacer par envoi réel d'email

  return { message: 'Code envoyé' }
}

//verification du code OTP
async verifyOtp(dto: VerifyOtpDto) {
    const record = await this.prisma.otpVerification.findFirst({ where: { otp: dto.otp } })
    if (!record || record.otp !== String(dto.otp) || record.expiresAt < new Date()) {
      throw new BadRequestException('OTP invalide ou expiré')    
    
    }

    const phone = record.phone 

    if(!record.phone) {
      throw new BadRequestException('OTP invalide')
    }
  await this.prisma.otpVerification.delete({ where: { phone: record.phone } })

    const tempToken = this.jwt.sign({ phone, verified:true, purpose: 'complete-profile',  jti: randomUUID()}, {secret: process.env.JWT_SECRET, expiresIn: '15m' }) 

    return {success: true, message:"Code verifié avec succès.",token: tempToken}
  }

  // async verifyEmailOtp(dto: VerifyOtpDto) {
  //   const record = await this.prisma.otpVerification.findUnique({ where: { phone: dto.otp } })
  //   if (!record || record.otp !== String(dto.otp) || record.expiresAt < new Date()) {
  //     throw new BadRequestException('OTP invalide ou expiré')    
  //   }
  // await this.prisma.otpVerification.delete({ where: { phone: dto.email } })

  //   const TempToken = this.jwt.sign(
  //     { email: dto.email, verified:true, purpose: 'complete-profile' }, 
  //     { secret: process.env.JWT_SECRET, expiresIn: '15m' })

  //     return {success: true, message:"Code verifié avec succès.", TempToken}
  // }


  private async generateUniqueOtp(): Promise<string> {
    let otp: string =''
    let exists: boolean = true
    while (exists) {
      otp = String(randomInt(100000, 999999))
      const found = await this.prisma.otpVerification.findFirst({ where: { otp, expiresAt: { gt: new Date()}} })
      exists = !!found
    }
    return otp
  }

  async completeProfile(@Req() req, @Body() dto: CompleteProfileDto) {
    //Extraire et vérifier le token temporaire du header Authorization
    let payload: any
    try {
      const token = req.headers.authorization?.split(' ')[1] 
      payload = this.jwt.verify(token,{ secret: process.env.JWT_SECRET })
    } catch {
      throw new BadRequestException('Ce lien a expiré, recommence le processus de connexion')
    }

    //Verifier que le purpose et le flag "verified" sont corrects, et que le token n'a pas déjà été utilisé (jti stocké en base)
    if (payload.purpose !== 'complete-profile' || !payload.verified) {
      throw new BadRequestException('Une erreur est survenue, recommence le processus de connexion')
    }

    //Vérifier que le Jti du token n'a pas été déjà consommé (pour éviter réutilisation du même token)
    const alreadyExists = await this.prisma.usedToken.findUnique({
      where: {jti: payload.jti},})
      if (alreadyExists) {
        throw new BadRequestException('Ce lien a expiré, recommence le processus de connexion')
      }

    //Verifier si le user n'existe pas déjà
    const identifier = payload.phone ? { phone: payload.phone } 
    : { email: payload.email }

    const existing = await this.prisma.user.findUnique({ where: identifier })

    if (existing) {
      throw new BadRequestException('Une erreur est survenue, recommence le processus de connexion')
    }

    //Créer le compte utilisateur et invalidation du token temporaire (en stockant son jti en base)
    const hash = await bcrypt.hash(dto.password, 10);
    const data: any = {
      firstname: dto.firstName,
      lastname: dto.lastName,
      hashedPassword: hash,
      role: $Enums.Role.ADMIN,
    }

    if (payload.phone) {
      data.phone = payload.phone
      data.phoneVerified = true
    // } else if (payload.email) {
    //   data.email = payload.email ‼️ Pour le flux de connexion par email, on ne vérifie pas l'email via OTP, donc on ne peut pas set "emailVerified" à true ici. Il faudrait implémenter un flux de vérification d'email similaire à celui du téléphone pour pouvoir le faire.
    //   data.emailVerified = true
    }

    const [user] = await this.prisma.$transaction([
      this.prisma.user.create({ data }),
      this.prisma.usedToken.create({ data: { jti: payload.jti } }), 
    ])
    
    return { token: this.signToken({ sub: user.id, role: user.role}) }
  }
  findAll() {
    return `This action returns all auth`;
  }

  findOne(id: number) {
    return `This action returns a #${id} auth`;
  }

  update(id: number, updateAuthDto: UpdateAuthDto) {
    return `This action updates a #${id} auth`;
  }

  remove(id: number) {
    return `This action removes a #${id} auth`;
  }
}
