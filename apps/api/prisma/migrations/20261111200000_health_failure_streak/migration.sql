-- M12: consecutive failed health checks of a running model server (see the reconciler).
-- Found by the M12 ramp benchmark: one slow check restarted a busy but healthy server.
ALTER TABLE "deployment_revisions" ADD COLUMN "health_failures" INTEGER NOT NULL DEFAULT 0;
