using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Reforma.Api.Migrations;

[Migration("20260717182500_TaskTimingPlanning")]
public partial class TaskTimingPlanning : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            ALTER TABLE "Tasks" ADD COLUMN IF NOT EXISTS "TimingKind" integer NOT NULL DEFAULT 0;
            ALTER TABLE "Tasks" ADD COLUMN IF NOT EXISTS "IsPlanningProvisional" boolean NOT NULL DEFAULT false;
            ALTER TABLE "Tasks" ADD COLUMN IF NOT EXISTS "PlanningWarning" text NULL;
        """);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            ALTER TABLE "Tasks" DROP COLUMN IF EXISTS "PlanningWarning";
            ALTER TABLE "Tasks" DROP COLUMN IF EXISTS "IsPlanningProvisional";
            ALTER TABLE "Tasks" DROP COLUMN IF EXISTS "TimingKind";
        """);
    }
}
