import { Module } from '@nestjs/common';
import { ExperimentsModule } from '../experiments/experiments.module';
import { RegistryController } from './registry.controller';
import { RegistryService } from './registry.service';

@Module({
  imports: [ExperimentsModule],
  controllers: [RegistryController],
  providers: [RegistryService],
})
export class RegistryModule {}
