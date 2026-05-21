import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Module({
  providers: [PrismaService],
  exports: [PrismaService], // permet de l'utiliser dans d'autres modules (ex: AuthModule, UsersModule)
})
export class PrismaModule {}
