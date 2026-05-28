import { Injectable, UnauthorizedException, BadRequestException, ConflictException } from '@nestjs/common';
import { CreateAuthDto } from './dto/create-auth.dto';
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

//inscription par téléphone : envoie OTP et vérification du code OTP

  async registerPhone(dto: RegisterPhoneDto){
    const exists = await this.prisma.user.findUnique({ where: { phone: dto.phone } })
    if (exists) throw new ConflictException('Numero de telephone déjà utilisé') //📝à changer 
    
      const otp = await this.generateUniqueOtp()
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // OTP valable 5 minutes
      await this.prisma.otpVerification.upsert({
        where: { phone: dto.phone },
        update: { otp, expiresAt },
        create: { phone: dto.phone, otp, expiresAt },
      })
      console.log(`OTP pour ${dto.phone} : ${otp}`) // Simule l'envoi du SMS
      return { message: 'OTP envoyé au numéro de téléphone' }
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
  async sendPhoneOtp(dto: RegisterPhoneDto) {
  const otp = await this.generateUniqueOtp()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5 min

  // upsert : crée l'entrée OTP si elle n'existe pas, la remplace sinon
  // (cas où l'utilisateur redemande un code avant expiration)
  await this.prisma.otpVerification.upsert({
    where: { phone: dto.phone },
    update: { otp, expiresAt },
    create: { phone: dto.phone, otp, expiresAt },
  })

  await this.smsService.sendOtp(dto.phone, otp)

  return { message: 'Code envoyé' }
}
//verification du code OTP
async verifyOtp(dto: VerifyOtpDto) {
    const record = await this.prisma.otpVerification.findUnique({ where: { phone: dto.phone } })
    if (!record || record.otp !== String(dto.otp) || record.expiresAt < new Date()) {
      throw new BadRequestException('OTP invalide ou expiré')
    }
    
    const user = await this.prisma.user.upsert({
      where: { phone: dto.phone },
      update: { phoneVerified: true },
      create: { phone: dto.phone, phoneVerified: true, role: $Enums.Role.ADMIN },
    })

  await this.prisma.otpVerification.delete({ where: { phone: dto.phone } })
    const token = this.signToken({ sub: user.id, role: user.role }) 

    return {success: true, message:"Code verifié avec succès.",token}
  }

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
