import { Module } from '@nestjs/common';
import { ExperimentsModule } from '../experiments/experiments.module';
import { DatasetsController } from './datasets';
import { RegistryController } from './registry.controller';
import { RegistryService } from './registry.service';

@Module({
  imports: [ExperimentsModule],
  controllers: [RegistryController, DatasetsController],
  providers: [RegistryService],
})
export class RegistryModule {}
