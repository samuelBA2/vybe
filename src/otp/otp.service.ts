import { Injectable, BadRequestException, InternalServerErrorException, Logger } from '@nestjs/common';
import { SmsService } from 'src/sms/sms.service';
import { randomInt } from 'crypto';
import { SendPhoneOtpDto } from 'src/auth/dto/send-phone-otp.dto';
import { MailService } from 'src/mail/mail.service';
import { PrismaService } from 'src/prisma/prisma.service';
import * as crypto from 'crypto';
import { Message } from 'twilio/lib/twiml/MessagingResponse';

// Durée de validité de l'OTP en millisecondes
const OTP_EXPIRATION_TIME = 5 * 60 * 1000; // 5 minutes

//Nombre max de tentatives de vérification avant blocage
const MAX_VERIFICATION_ATTEMPTS = 5;

@Injectable()
export class OtpService {
    private readonly logger = new Logger (OtpService.name);// Logger pour suivre les activités de l'OTPService

    constructor(
        private readonly smsService: SmsService,
        private readonly mailService: MailService,
        private readonly prisma: PrismaService,

    ) {}

    //envoi otp par mail 

    async sendEmailOtp(email: string) {
        const exists = await this.prisma.user.findUnique({ where: { email } })

        if (exists) {
            //envoi quand meme un message generique sans reveler que le compte existe
            await this.mailService.sendOtp(email, "Quelqu'un tente de s'inscrire avec votre adresse email vybe. Si ce n'est pas vous, ignorez ce message.")

            return{
                message:"Un code de verification vous a été envoyé par email"
            }
        }

        const otp = await this.generateUniqueOtp();
        await this.persistOtp(email, otp);
        
        try{
            await this.mailService.sendOtp(email, otp);
        } catch (error){
            this.logger.error(`Erreur lors de l'envoi de l'OTP à ${email}: ${error.message}`);
            throw new InternalServerErrorException('Impossible d\'envoyer le code de vérification. Veuillez réessayer plus tard.');
        }
    return { message: 'Un code de verification vous a été envoyé par email' }
    }

    async sendPhoneOtp(phone: string) {
        //verifier si le numéro est déjà associé à un compte
    const exists = await this.prisma.user.findUnique({ where: { phone } })
        if (exists) {
        await this.smsService.sendOtp(phone, "Quelqu'un tente de s'inscrire avec votre numéro vybe. Si ce n'est pas vous, ignorez ce message.")
    
        return{
            message:"Un code de verification vous a été envoyé"
            }
        }
        const otp = await this.generateUniqueOtp();
        await this.persistOtp(phone, otp);

        try{
            await this.smsService.sendOtp(phone, `Votre code de verification vybe :${otp}`);
        }catch (error){
            this.logger.error(`Erreur lors de l'envoi de l'OTP à ${phone}: ${error.message}`);
            throw new InternalServerErrorException('Impossible d\'envoyer le code de vérification. Veuillez réessayer plus tard.');
        }
        return { message: 'Un code de verification vous a été envoyé' }
    }

    async verifyOtp(identifier: string, code: string): Promise<void> {
        // Cette méthode sera appelée depuis AuthService pour vérifier le code OTP
        // Elle doit vérifier que le code est correct, non expiré, et que le nombre de tentatives n'est pas dépassé
        // Si la vérification échoue, elle doit incrémenter le nombre de tentatives et éventuellement bloquer l'OTP
        // Si la vérification réussit, elle doit marquer l'OTP comme utilisé

        const record = await this.prisma.otpVerification.findFirst({ 
            where: { identifier, used: false, expiresAt: { gt: new Date() } } });
            orderBy : { createdAt: 'desc' } // on prend le plus récent

        if (!record) {
            throw new BadRequestException('Code OTP invalide ou expiré');
        }

        if (record.attempts >= MAX_VERIFICATION_ATTEMPTS) {
            await this.prisma.otpVerification.update({ where: { id: record.id }, data: { used: true } });
            throw new BadRequestException('Nombre de tentatives dépassé. Veuillez demander un nouveau code.');
        }

        if (record.code !== code){
            await this.prisma.otpVerification.update({
                where: { id: record.id },
                data: { attempts: { increment: 1} },
            })
            throw new BadRequestException('Code OTP invalide ou expiré');
        }
        await this.prisma.otpVerification.update({ 
            where: { id: record.id }, 
            data: { used: true } 
        });
    }
    
    private async generateUniqueOtp(): Promise<string>{
        let otp: string ='';
        let exists: boolean = true;

        while(exists){
            otp = String(randomInt(100000, 999999));
            const found = await this.prisma.otpVerification.findFirst({ where: { code: otp, used: false, expiresAt: { gt: new Date()}} });
            exists = !!found;
        }
        return otp;
    }
    private async persistOtp(identifier: string, code: string): Promise<void> {
    const expiresAt = new Date(Date.now() + OTP_EXPIRATION_TIME) // 5 min
    
      // upsert : crée l'entrée OTP si elle n'existe pas, la remplace sinon
      // (cas où l'utilisateur redemande un code avant expiration)
    await this.prisma.$transaction(async (tx) => {
        await tx.otpVerification.updateMany({
            where: { identifier, used: false},
            data: { used: true }, // invalide les OTP précédents non utilisés
    });
    
    await tx.otpVerification.create({data : {
        identifier, code, expiresAt, used: false, attempts: 0 },
        });
    });
    }
}

    
    

