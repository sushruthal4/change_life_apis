import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Heart Fuel worker", () => {
	it("responds with API health JSON (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		const body = await response.json() as { success: boolean; data: string };
		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.data).toContain("API is running");
	});

	it("responds with API health JSON (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		const body = await response.json() as { success: boolean; data: string };
		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.data).toContain("API is running");
	});
});
