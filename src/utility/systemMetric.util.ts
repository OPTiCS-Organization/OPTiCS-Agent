import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import os from 'os-utils';
import { numberSlicer } from './numberSlicer.util';

// 메모리는 동기 측정이라 자주 표본을 떠도 부담이 없다.
const MEM_SAMPLE_INTERVAL_MS = 250;
// os-utils의 cpuUsage는 내부적으로 1초 측정 창을 쓰므로 그보다 자주 떠봐야 의미가 없다.
const CPU_SAMPLE_INTERVAL_MS = 1000;

export interface ResourceMetric {
  peak: number;
  average: number;
  min: number;
}

export interface MemoryMetric extends ResourceMetric {
  totalMemory: number;
}

export interface SystemMetrics {
  timestamp: number;
  cpu: ResourceMetric;
  mem: MemoryMetric;
  samples: { cpu: number; mem: number };
}

/**
 * CPU/메모리 사용량을 각각의 주기로 표본 수집하고,
 * getMetrics() 호출 시 누적 구간을 집계해 반환하면서 카운터를 초기화한다(drain).
 * CPU와 메모리는 측정 비용이 달라 표본 수를 따로 센다.
 */
@Injectable()
export class SystemMetricsUtility implements OnModuleInit, OnModuleDestroy {
  private cpuTimer?: NodeJS.Timeout;
  private memTimer?: NodeJS.Timeout;

  private cpuSamples = 0;
  private cpuMax = 0;
  private cpuMin = Infinity;
  private cpuSum = 0;

  private memSamples = 0;
  private memMax = 0;
  private memMin = Infinity;
  private memSum = 0;
  private totalMemory = 0;

  onModuleInit() {
    this.cpuTimer = setInterval(() => this.collectCpu(), CPU_SAMPLE_INTERVAL_MS);
    this.memTimer = setInterval(() => this.collectMem(), MEM_SAMPLE_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.cpuTimer) clearInterval(this.cpuTimer);
    if (this.memTimer) clearInterval(this.memTimer);
  }

  private collectCpu() {
    // cpuUsage는 1초 측정 후 콜백하므로, 측정이 끝난 시점에 카운트한다.
    os.cpuUsage((usage) => {
      this.cpuMax = Math.max(this.cpuMax, usage);
      this.cpuMin = Math.min(this.cpuMin, usage);
      this.cpuSum += usage;
      this.cpuSamples++;
    });
  }

  private collectMem() {
    const used = os.totalmem() - os.freemem();
    this.memMax = Math.max(this.memMax, used);
    this.memMin = Math.min(this.memMin, used);
    this.memSum += used;
    this.totalMemory = os.totalmem();
    this.memSamples++;
  }

  /** 누적된 구간을 집계해 반환하고 카운터를 리셋한다. */
  public getMetrics(): SystemMetrics {
    const metrics: SystemMetrics = {
      timestamp: Date.now(),
      cpu: {
        peak: this.finite(this.cpuMax),
        average: this.average(this.cpuSum, this.cpuSamples),
        min: this.finite(this.cpuMin),
      },
      mem: {
        peak: this.finite(this.memMax),
        average: this.average(this.memSum, this.memSamples),
        min: this.finite(this.memMin),
        totalMemory: this.finite(this.totalMemory),
      },
      samples: { cpu: this.cpuSamples, mem: this.memSamples },
    };
    this.reset();
    return metrics;
  }

  /** 표본이 0이면 0으로 나누는 것을 막는다. */
  private average(sum: number, samples: number): number {
    return samples > 0 ? numberSlicer(sum / samples) : 0;
  }

  /** min이 Infinity로 남은 경우(표본 0) 등 비정상 값을 0으로 보정한다. */
  private finite(value: number): number {
    return Number.isFinite(value) ? numberSlicer(value) : 0;
  }

  private reset() {
    this.cpuSamples = 0;
    this.cpuMax = 0;
    this.cpuMin = Infinity;
    this.cpuSum = 0;
    this.memSamples = 0;
    this.memMax = 0;
    this.memMin = Infinity;
    this.memSum = 0;
    // totalMemory는 누적값이 아니라 현재 스냅샷이라 리셋하지 않는다.
  }
}
