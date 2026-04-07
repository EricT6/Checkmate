import { describe, expect, it, jest } from "@jest/globals";
import { SuperSimpleQueueHelper } from "../src/service/infrastructure/SuperSimpleQueue/SuperSimpleQueueHelper.ts";
import type { Monitor } from "../src/types/monitor.ts";

const createLogger = () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });

const createHelper = () => {
	const maintenanceWindowsRepository = {
		findByMonitorId: jest.fn(() => Promise.resolve([])),
	};
	const statusServiceMock = {
		updateMonitorStatus: jest.fn(() => Promise.resolve({ monitor: { id: "m1" }, statusChanged: true, prevStatus: false })),
	};
	const notificationsServiceMock = {
		handleNotifications: jest.fn(() => Promise.resolve(undefined)),
		sendEscalationNotification: jest.fn(() => Promise.resolve(true)),
	};
	const checkServiceMock = {
		buildCheck: jest.fn(() => Promise.resolve({})),
	};
	const incidentServiceMock = {
		handleIncident: jest.fn(() => Promise.resolve(undefined)),
	};
	const helper = new SuperSimpleQueueHelper(
		createLogger() as never,
		{ requestStatus: jest.fn() } as never,
		statusServiceMock as never,
		notificationsServiceMock as never,
		checkServiceMock as never,
		{ getSettings: jest.fn(() => ({})) } as never,
		{ addToBuffer: jest.fn() } as never,
		incidentServiceMock as never,
		maintenanceWindowsRepository as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never
	);

	return { helper, maintenanceWindowsRepository, notificationsServiceMock, statusServiceMock, incidentServiceMock };
};

describe("SuperSimpleQueueHelper", () => {
	describe("getHeartbeatJob", () => {
		it("skips execution when monitor is in maintenance window", async () => {
			const { helper } = createHelper();
			const spy = jest.spyOn(helper, "isInMaintenanceWindow").mockResolvedValue(true);
			const job = helper.getHeartbeatJob();
			await job({ id: "m1", teamId: "team", interval: 60000 } as Monitor);
			expect((helper as any)["networkService"].requestStatus).not.toHaveBeenCalled();
			expect((helper as any)["logger"].debug).toHaveBeenCalledWith(
				expect.objectContaining({ message: expect.stringContaining("Monitor m1 is in maintenance window") })
			);
			spy.mockRestore();
		});

		it("processes monitor status and notifications when active", async () => {
			const networkResponse = { monitor: { id: "m1" }, status: true };
			const updatedMonitor = { id: "m1", status: true };
			const { helper } = createHelper();
			(helper as any)["networkService"].requestStatus = jest.fn(() => Promise.resolve(networkResponse));
			(helper as any)["statusService"].updateMonitorStatus = jest.fn(() =>
				Promise.resolve({ monitor: updatedMonitor, statusChanged: true, prevStatus: false, code: 200 })
			);
			jest.spyOn(helper, "isInMaintenanceWindow").mockResolvedValue(false);
			const job = helper.getHeartbeatJob();
			const monitor = { id: "m1", teamId: "team" } as Monitor;
			await job(monitor);
			expect((helper as any)["networkService"].requestStatus).toHaveBeenCalledWith(monitor);
		});

		it("sends escalation only after the configured duration", async () => {
			const now = Date.now();
			const monitor = { id: "m1", teamId: "team", escalation: { afterMinutes: 5, notificationId: "n1" } } as Monitor;
			const { helper } = createHelper();
			(helper as any)["networkService"].requestStatus = jest.fn(() => Promise.resolve({ monitor, status: false, code: 500 }));
			(helper as any)["statusService"].updateMonitorStatus = jest.fn(() =>
				Promise.resolve({ monitor, statusChanged: false, prevStatus: false, code: 500 })
			);
			(helper as any)["incidentsRepository"] = {
				findActiveByMonitorId: jest.fn(() =>
					Promise.resolve({
						id: "i1",
						teamId: "team",
						monitorId: "m1",
						startTime: new Date(now - 6 * 60000).toISOString(),
						status: true,
						escalationNotifiedAt: null,
					})
				),
				updateById: jest.fn(() => Promise.resolve(undefined)),
			};
			jest.spyOn(helper, "isInMaintenanceWindow").mockResolvedValue(false);
			const job = helper.getHeartbeatJob();
			await job(monitor);
			expect((helper as any)["notificationsService"].sendEscalationNotification).toHaveBeenCalledWith(
				monitor,
				expect.any(Object),
				"n1",
				5
			);
			expect((helper as any)["incidentsRepository"].updateById).toHaveBeenCalledWith(
				"i1",
				"team",
				expect.objectContaining({ escalationNotifiedAt: expect.any(String) })
			);
		});

		it("throws when monitor id is missing", async () => {
			const { helper } = createHelper();
			const job = helper.getHeartbeatJob();
			await expect(job({} as Monitor)).rejects.toThrow("No monitor id");
			expect((helper as any)["logger"].warn).toHaveBeenCalled();
		});
	});

	describe("isInMaintenanceWindow", () => {
		it("returns true when an active window spans now", async () => {
			const now = new Date();
			const { helper, maintenanceWindowsRepository } = createHelper();
			maintenanceWindowsRepository.findByMonitorId = jest.fn(() =>
				Promise.resolve([
				{
					active: true,
					start: new Date(now.getTime() - 1000).toISOString(),
					end: new Date(now.getTime() + 1000).toISOString(),
					repeat: 0,
				}
			] as never[])
			);
			await expect(helper.isInMaintenanceWindow("m1", "team")).resolves.toBe(true);
		});

		it("returns true when repeat interval advances window into current time", async () => {
			const now = Date.now();
			const { helper, maintenanceWindowsRepository } = createHelper();
			maintenanceWindowsRepository.findByMonitorId = jest.fn(() =>
				Promise.resolve([
				{
					active: true,
					start: new Date(now - 7200000).toISOString(),
					end: new Date(now - 6600000).toISOString(),
					repeat: 3600000,
				}
			] as never[])
			);
			await expect(helper.isInMaintenanceWindow("m1", "team")).resolves.toBe(true);
		});

		it("returns false when no active windows exist", async () => {
			const { helper } = createHelper();
			await expect(helper.isInMaintenanceWindow("m1", "team")).resolves.toBe(false);
		});
	});
});
