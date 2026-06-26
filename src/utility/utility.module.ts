import { Module } from "@nestjs/common";
import { SystemMetricsUtility } from "./systemMetric.util";

@Module({
  providers: [SystemMetricsUtility],
  exports: [SystemMetricsUtility]
})
export class UtilityModule {};