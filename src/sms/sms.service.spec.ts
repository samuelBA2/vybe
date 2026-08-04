import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SmsService } from './sms.service';

describe('SmsService', () => {
  let service: SmsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmsService,
        // Le constructeur instancie `new Twilio(sid, token)` : Twilio exige un
        // accountSid commençant par "AC", d'où cette valeur factice.
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('AC' + '0'.repeat(32)) },
        },
      ],
    }).compile();

    service = module.get<SmsService>(SmsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
