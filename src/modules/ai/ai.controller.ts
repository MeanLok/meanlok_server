import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import type { Profile } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AiService } from './ai.service';
import { AskDto } from './dto/ask.dto';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('usage')
  getUsage(@CurrentUser() user: Profile) {
    return this.aiService.getUsage(user.id);
  }

  @Post('ask')
  ask(@CurrentUser() user: Profile, @Body() dto: AskDto) {
    return this.aiService.ask(user.id, dto.question);
  }
}
