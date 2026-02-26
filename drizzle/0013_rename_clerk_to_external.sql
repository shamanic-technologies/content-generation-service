ALTER TABLE "orgs" RENAME COLUMN "clerk_org_id" TO "external_org_id";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "clerk_user_id" TO "external_user_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_orgs_clerk_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_users_clerk_id";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_orgs_external_id" ON "orgs" USING btree ("external_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_external_id" ON "users" USING btree ("external_user_id");
