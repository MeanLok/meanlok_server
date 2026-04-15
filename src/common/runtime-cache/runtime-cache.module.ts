import { Global, Module } from '@nestjs/common';
import { RuntimeCacheService } from './runtime-cache.service';

@Global()
@Module({
  providers: [RuntimeCacheService],
  exports: [RuntimeCacheService],
})
export class RuntimeCacheModule {}
