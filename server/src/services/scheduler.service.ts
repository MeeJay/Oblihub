import { stackService } from './stack.service';
import { updateService } from './update.service';
import { logger } from '../utils/logger';

const timers = new Map<number, ReturnType<typeof setInterval>>();

export const schedulerService = {
  /** Start all scheduled checks for enabled stacks */
  async startAll(): Promise<void> {
    const stacks = await stackService.getAll();
    for (const stack of stacks) {
      if (stack.enabled) {
        this.schedule(stack.id, stack.checkInterval);
      }
    }
    logger.info({ count: timers.size }, 'Scheduler started');
  },

  /** Schedule checks for a specific stack */
  schedule(stackId: number, intervalSeconds: number): void {
    // Clear existing timer
    this.unschedule(stackId);

    const timer = setInterval(async () => {
      try {
        await updateService.checkStack(stackId);
      } catch (err) {
        logger.error({ stackId, err }, 'Scheduled check failed');
      }
    }, intervalSeconds * 1000);

    timers.set(stackId, timer);
    logger.info({ stackId, intervalSeconds }, 'Stack check scheduled');
  },

  /** Unschedule checks for a stack */
  unschedule(stackId: number): void {
    const existing = timers.get(stackId);
    if (existing) {
      clearInterval(existing);
      timers.delete(stackId);
    }
  },

  /** Reschedule after config change */
  reschedule(stackId: number, intervalSeconds: number, enabled: boolean): void {
    this.unschedule(stackId);
    if (enabled) {
      this.schedule(stackId, intervalSeconds);
    }
  },

  /** Stop all timers (graceful shutdown) */
  stopAll(): void {
    for (const [stackId, timer] of timers) {
      clearInterval(timer);
      timers.delete(stackId);
    }
    logger.info('Scheduler stopped');
  },
};
