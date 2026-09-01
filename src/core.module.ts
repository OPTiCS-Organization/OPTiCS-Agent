import { Module } from '@nestjs/common';
import { AppService } from './app.service';
import { DashboardGateway } from './dashboard.gateway';
import { DockerModule } from './docker/docker.module';
import { PrismaModule } from './share/prisma.module';
import { UtilityModule } from './utility/utility.module';

/**
 * 루트에 있던 `AppService`·`DashboardGateway`의 소유 모듈입니다.
 *
 * 둘 다 원래 AppModule이 직접 provide했는데, TunnelService가 AppService를 주입받으면서
 * 문제가 생겼습니다. TunnelModule이 AppService를 쓰려면 AppModule을 import해야 하는데
 * AppModule은 이미 TunnelModule을 import하고 있어 순환이 됩니다.
 *
 * 그래서 소유권을 이 모듈로 내렸습니다. AppModule과 TunnelModule 둘 다 여기를
 * import하면 되고, 인스턴스는 하나로 유지됩니다.
 */
@Module({
  imports: [DockerModule, PrismaModule, UtilityModule],
  providers: [AppService, DashboardGateway],
  exports: [AppService, DashboardGateway],
})
export class CoreModule {}
