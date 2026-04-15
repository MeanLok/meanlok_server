import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiRedisRestService } from './ai-redis-rest.service';
import { AiService } from './ai.service';

@Module({
  controllers: [AiController],
  providers: [AiService, AiRedisRestService],
})
export class AiModule {}
