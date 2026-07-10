import { SignJWT } from "jose";
import { authenticator } from "otplib";
import { jwtVerify } from "jose";
const cors = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization"
};

type Env = {
	SUPABASE_URL: string;
	SUPABASE_KEY: string;
	JWT_SECRET: string;
};

type DonationCreateBody = {
	donor_name?: unknown;
	donor_email?: unknown;
	donor_phone?: unknown;
	amount?: unknown;
	cause_id?: unknown;
};

class SupabaseRequestError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "SupabaseRequestError";
		this.status = status;
	}
}

// ================= RESPONSE HELPERS =================

function jsonResponse(body: any, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...cors, "Content-Type": "application/json" }
	});
}

// ================= AUTH =================

async function verifyAdmin(request: Request, env: Env) {
	const auth = request.headers.get("Authorization");
	if (!auth) return null;

	try {
		const token = auth.replace("Bearer ", "");
		const secret = new TextEncoder().encode(env.JWT_SECRET);

		const { payload } = await jwtVerify(token, secret);

		return payload; // ✅ valid user
	} catch {
		return null;
	}
}

// ================= SUPABASE CALL =================

async function callSupabase(env: Env, path: string, init?: RequestInit) {
	try {
		if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
			throw new Error("Supabase configuration missing");
		}

		const res = await fetch(`${env.SUPABASE_URL}${path}`, {
			...init,
			headers: {
				apikey: env.SUPABASE_KEY,
				Authorization: `Bearer ${env.SUPABASE_KEY}`,
				...(init?.headers || {})
			}
		});

		//  handle NO CONTENT (DELETE, etc.)
		if (res.status === 204) {
			return null;
		}

		const text = await res.text();
		const contentType = res.headers.get("Content-Type") || "unknown";

		//  empty response safety
		if (!text) {
			if (!res.ok) {
				throw new Error(`Supabase ${res.status} ${res.statusText}`);
			}
			return null;
		}

		//  parse safely
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			const preview = text.replace(/\s+/g, " ").slice(0, 180);
			throw new Error(
				`Invalid JSON from Supabase (${res.status} ${res.statusText}, ${contentType}): ${preview}`
			);
		}

		if (!res.ok) {
			const message =
				typeof data?.message === "string"
					? data.message
					: typeof data?.msg === "string"
						? data.msg
						: JSON.stringify(data);
			throw new SupabaseRequestError(
				`Supabase ${res.status} ${res.statusText}: ${message}`,
				res.status
			);
		}

		return data;
	} catch (err: any) {
		if (err instanceof SupabaseRequestError) {
			throw err;
		}

		// don't return Response here
		throw new Error(err.message || "Supabase request failed");
	}
}

async function getBody(request: Request): Promise<any | null> {
	try {
		return await request.json();
	} catch {
		return null;
	}
}

function sanitizeText(value: unknown, maxLength = 180) {
	if (typeof value !== "string") return "";
	return value.trim().slice(0, maxLength);
}

function normalizePhone(value: unknown) {
	const digits = String(value || "").replace(/\D/g, "");
	return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalizeAmount(value: unknown) {
	const amount = Number(value);
	if (!Number.isFinite(amount)) return 0;
	return Math.round(amount * 100) / 100;
}

function generateOrderId() {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	const suffix = Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase();

	return `HF_${Date.now()}_${suffix}`;
}

function encodeFilterValue(value: string) {
	return encodeURIComponent(value);
}

function toDonationStatus(donation: Record<string, any>) {
	return {
		id: donation.id,
		order_id: donation.order_id,
		donor_name: donation.donor_name,
		amount: Number(donation.amount || 0),
		payment_status: donation.payment_status,
		donor_number: donation.donor_number,
		cause_id: donation.cause_id,
		created_at: donation.created_at,
		updated_at: donation.updated_at
	};
}

async function getDonationByOrderId(env: Env, orderId: string) {
	const result = await callSupabase(
		env,
		`/rest/v1/donations?order_id=eq.${encodeFilterValue(orderId)}&select=*&limit=1`
	);

	return result?.[0] || null;
}

function indiaDateKey(value: string | Date) {
	const date = value instanceof Date ? value : new Date(value);
	const indiaTime = new Date(date.getTime() + 330 * 60 * 1000);
	return indiaTime.toISOString().slice(0, 10);
}

type LoginBody = {
	email: string;
	token: string;
};

type UserRecord = Record<string, any>;

const TWO_FACTOR_SECRET_KEYS = [
	"twoFactorSecret",
	"twofactorsecret",
	"two_factor_secret"
];

const TWO_FACTOR_ENABLED_KEYS = [
	"twoFactorEnabled",
	"twofactorenabled",
	"two_factor_enabled"
];

function getExistingColumnName(
	record: UserRecord,
	keys: string[],
	fallback: string
) {
	return keys.find((key) => Object.prototype.hasOwnProperty.call(record, key)) || fallback;
}

function getUserTwoFactorSecret(user: UserRecord) {
	return TWO_FACTOR_SECRET_KEYS
		.map((key) => user[key])
		.find((value) => typeof value === "string" && value.length > 0);
}

function getUserTwoFactorEnabled(user: UserRecord) {
	return TWO_FACTOR_ENABLED_KEYS.some((key) => user[key] === true);
}

function normalizeUserWritePayload(body: Record<string, any>, existingUser?: UserRecord) {
	const payload = { ...body };
	const reference = existingUser || body;
	const secretColumn = getExistingColumnName(
		reference,
		TWO_FACTOR_SECRET_KEYS,
		"twofactorsecret"
	);
	const enabledColumn = getExistingColumnName(
		reference,
		TWO_FACTOR_ENABLED_KEYS,
		"twofactorenabled"
	);

	for (const key of TWO_FACTOR_SECRET_KEYS) {
		if (key in payload && key !== secretColumn) {
			payload[secretColumn] = payload[key];
			delete payload[key];
		}
	}

	for (const key of TWO_FACTOR_ENABLED_KEYS) {
		if (key in payload && key !== enabledColumn) {
			payload[enabledColumn] = payload[key];
			delete payload[key];
		}
	}

	return payload;
}

function getSiteContentTable(
	pathname: string
) {
	if (pathname === "/api/site-content") {
		return "site_content";
	}

	return null;
}

function successResponse(data: any, message = "Success", status = 200) {
	return new Response(
		JSON.stringify({
			success: true,
			message,
			data
		}),
		{
			status,
			headers: { ...cors, "Content-Type": "application/json" }
		}
	);
}

function errorResponse(message: string, status = 400) {
	return new Response(
		JSON.stringify({
			success: false,
			message
		}),
		{
			status,
			headers: { ...cors, "Content-Type": "application/json" }
		}
	);
}

// ------------------images delete -------------------------

function getStorageObjectPath(url: string, bucket: string) {
	const marker = "/storage/v1/object/public/";
	const parts = url.split(marker);
	const pathWithBucket = parts[1] || url;
	const bucketPrefix = `${bucket}/`;

	return pathWithBucket.startsWith(bucketPrefix)
		? pathWithBucket.slice(bucketPrefix.length)
		: pathWithBucket;
}

function getStorageBucketForFile(file: File): "images" | "videos" | "documents" {
	if (file.type.startsWith("video/")) return "videos";
	if (file.type.startsWith("image/")) return "images";
	return "documents";
}

function sanitizeStorageFileName(fileName: string) {
	return fileName
		.trim()
		.replace(/\s+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-");
}

function encodeStoragePath(path: string) {
	return path
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

async function uploadFileToStorage(env: Env, file: File, bucket: string, folder: string) {
	if (!["images", "videos", "documents"].includes(bucket)) {
		throw new Error("Invalid storage bucket");
	}

	const cleanFolder = folder.replace(/^\/+|\/+$/g, "") || "uploads";
	const safeName = sanitizeStorageFileName(file.name || "upload");
	const path = `${cleanFolder}/${crypto.randomUUID()}-${safeName}`;
	const res = await fetch(
		`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${encodeStoragePath(path)}`,
		{
			method: "POST",
			headers: {
				apikey: env.SUPABASE_KEY,
				Authorization: `Bearer ${env.SUPABASE_KEY}`,
				"Content-Type": file.type || "application/octet-stream",
				"x-upsert": "false"
			},
			body: file
		}
	);

	if (!res.ok) {
		const text = await res.text();
		throw new SupabaseRequestError(
			`Supabase ${res.status} ${res.statusText}: ${text || "Upload failed"}`,
			res.status
		);
	}

	return {
		url: `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`,
		path,
		bucket,
		originalName: file.name,
		resourceType: file.type.startsWith("video/")
			? "video"
			: file.type.startsWith("image/")
				? "image"
				: "document"
	};
}

async function deleteImagesFromStorage(env: Env, imageUrls: string[]) {
	try {
		const filePaths = imageUrls.map((url) => {
			return getStorageObjectPath(url, "images");
		});

		await fetch(`${env.SUPABASE_URL}/storage/v1/object/remove`, {
			method: "POST",
			headers: {
				apikey: env.SUPABASE_KEY,
				Authorization: `Bearer ${env.SUPABASE_KEY}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				bucket: "images",
				paths: filePaths
			})
		});
	} catch (err) {
		console.error("Image delete failed:", err);
	}
}

async function deleteVideosFromStorage(
	env: Env,
	videoUrls: string[]
) {
	try {
		const filePaths = videoUrls.map((url) => {
			return getStorageObjectPath(url, "videos");
		});

		await fetch(
			`${env.SUPABASE_URL}/storage/v1/object/remove`,
			{
				method: "POST",
				headers: {
					apikey: env.SUPABASE_KEY,
					Authorization: `Bearer ${env.SUPABASE_KEY}`,
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					bucket: "videos",
					paths: filePaths
				})
			}
		);
	} catch (err) {
		console.error(err);
	}
}
// ================= MAIN =================

export default {
	async fetch(request: Request, env: Env) {
		try {
			if (request.method === "OPTIONS") {
				return new Response(null, { headers: cors });
			}

			const url = new URL(request.url);

			// ================= AUTH PROTECTION =================

			const publicPostPaths = [
				"/api/donations/create-order"
			];

			const isPublic =
				request.method === "GET" ||
				publicPostPaths.includes(url.pathname) ||
				url.pathname === "/api/users/login" ||
				url.pathname === "/api/users/register" ||
				url.pathname === "/api/users/2fa/setup" ||
				url.pathname === "/api/users/2fa/verify-setup";

			if (!isPublic && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
				const admin = await verifyAdmin(request, env);
				if (!admin) return errorResponse("Unauthorized", 401);
			}

			// ================= USERS =================
			if (url.pathname === "/" && request.method === "GET") {
				return successResponse("API is running 🚀");
			}

			// ================= DONATIONS / UPI =================

			if (url.pathname === "/api/donations/create-order" && request.method === "POST") {
				const body = (await getBody(request)) as DonationCreateBody | null;
				if (!body) return errorResponse("Invalid or empty JSON body", 400);

				const amount = normalizeAmount(body.amount);
				const donorPhone = normalizePhone(body.donor_phone);
				const donorName = sanitizeText(body.donor_name, 120) || "Anonymous Donor";
				const donorEmail = sanitizeText(body.donor_email, 254);
				const causeId = sanitizeText(body.cause_id, 80);

				if (amount < 1) {
					return errorResponse("Donation amount must be at least ₹1", 400);
				}

				if (donorPhone.length !== 10) {
					return errorResponse("A valid 10 digit donor phone number is required", 400);
				}

				const orderId = generateOrderId();
				const donationPayload: Record<string, any> = {
					order_id: orderId,
					donor_name: donorName,
					donor_email: donorEmail || null,
					donor_phone: donorPhone,
					amount,
					payment_status: "PENDING"
				};

				if (causeId) {
					donationPayload.cause_id = causeId;
				}

				const donationResult = await callSupabase(env, "/rest/v1/donations", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Prefer": "return=representation"
					},
					body: JSON.stringify(donationPayload)
				});
				const donation = donationResult?.[0];

				return successResponse(
					{
						id: donation?.id,
						order_id: orderId,
						amount,
						donor_name: donorName,
						payment_status: donation?.payment_status || "PENDING"
					},
					"Donation order created successfully"
				);
			}

			const donationStatusMatch = url.pathname.match(/^\/api\/donations\/([^/]+)\/status$/);
			if (donationStatusMatch && request.method === "GET") {
				const orderId = decodeURIComponent(donationStatusMatch[1]);
				let donation = await getDonationByOrderId(env, orderId);

				if (!donation) {
					return errorResponse("Donation order not found", 404);
				}

				return successResponse(
					toDonationStatus(donation),
					"Donation status fetched successfully"
				);
			}

			if (url.pathname === "/api/donations" && request.method === "GET") {
				const admin = await verifyAdmin(request, env);
				if (!admin) return errorResponse("Unauthorized", 401);

				const result = await callSupabase(
					env,
					"/rest/v1/donations?select=*&order=created_at.desc"
				);

				return successResponse(result, "Donations fetched successfully");
			}

			if (url.pathname === "/api/dashboard" && request.method === "GET") {
				const admin = await verifyAdmin(request, env);
				if (!admin) return errorResponse("Unauthorized", 401);

				const donations = await callSupabase(
					env,
					"/rest/v1/donations?select=amount,payment_status,created_at,updated_at"
				);
				const today = indiaDateKey(new Date());

				const totals = (donations || []).reduce(
					(acc: Record<string, number>, donation: Record<string, any>) => {
						const amount = Number(donation.amount || 0);
						const status = donation.payment_status;

						acc.total_donations += 1;

						if (status === "SUCCESS") {
							acc.total_amount += amount;
							acc.successful_payments += 1;

							const paidDate = indiaDateKey(donation.updated_at || donation.created_at);
							if (paidDate === today) {
								acc.today_amount += amount;
							}
						}

						if (["FAILED", "USER_DROPPED", "CANCELLED"].includes(status)) {
							acc.failed_payments += 1;
						}

						if (status === "PENDING") {
							acc.pending_payments += 1;
						}

						return acc;
					},
					{
						total_donations: 0,
						total_amount: 0,
						today_amount: 0,
						successful_payments: 0,
						failed_payments: 0,
						pending_payments: 0
					}
				);

				return successResponse(totals, "Dashboard fetched successfully");
			}

			if (url.pathname === "/api/storage/upload" && request.method === "POST") {
				const formData = await request.formData();
				const file = formData.get("file");

				if (!(file instanceof File)) {
					return errorResponse("File required", 400);
				}

				const requestedBucket = String(formData.get("bucket") || "");
				const bucket = requestedBucket || getStorageBucketForFile(file);
				const folder = String(formData.get("folder") || "uploads");
				const result = await uploadFileToStorage(env, file, bucket, folder);

				return successResponse(result, "File uploaded successfully");
			}

			if (url.pathname === "/api/users/register" && request.method === "POST") {
				const body = (await getBody(request)) as Record<string, any> | null;
				if (!body) return errorResponse("Invalid or empty JSON body", 400);
				if (!body.email) return errorResponse("Email required");

				const result = await callSupabase(env, "/rest/v1/users", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Prefer": "return=representation"
					},
					body: JSON.stringify(normalizeUserWritePayload(body))
				});
				return successResponse(result, "User created successfully");
			}

			if (url.pathname === "/api/users/login" && request.method === "POST") {
				const body = (await request.json()) as Record<string, any>;
				if (!body.email || !body.token) {
					return errorResponse("Email and token required");
				}

				const res = await fetch(
					`${env.SUPABASE_URL}/rest/v1/users?email=eq.${body.email}`,
					{
						headers: {
							apikey: env.SUPABASE_KEY,
							Authorization: `Bearer ${env.SUPABASE_KEY}`
						}
					}
				);

				const text = await res.text();

				let users;
				try {
					users = JSON.parse(text);
				} catch {
					return errorResponse("Invalid DB response", 500);
				}

				if (!users || users.length === 0) {
					return errorResponse("User not found", 404);
				}

				const user = users[0];

				const twoFactorSecret = getUserTwoFactorSecret(user);

				if (!twoFactorSecret) {
					return errorResponse("2FA not setup", 400);
				}
				if (!env.JWT_SECRET) {
					return errorResponse("JWT_SECRET missing", 500);
				}
				const verified = authenticator.check(
					String(body.token),
					twoFactorSecret
				);

				if (!verified) return errorResponse("Invalid OTP", 401);
				if (!env.JWT_SECRET || typeof env.JWT_SECRET !== "string") {
					return errorResponse("JWT_SECRET invalid", 500);
				}
				const secret = new TextEncoder().encode(env.JWT_SECRET);

				const token = await new SignJWT({ id: user.id, role: user.role })
					.setProtectedHeader({ alg: "HS256" })
					.setExpirationTime("7d")
					.sign(secret);

				const safeUser = { ...user };
				for (const key of TWO_FACTOR_SECRET_KEYS) {
					delete safeUser[key];
				}

				return successResponse(
					{
						user: safeUser,
						token
					},
					"Login successful"
				);
			}

			if (url.pathname === "/api/users" && request.method === "GET") {
				const users = await callSupabase(env, "/rest/v1/users?select=*");
				return successResponse(users, "Users fetched successfully");
			}

			if (url.pathname.startsWith("/api/users/") && request.method === "GET") {
				const id = url.pathname.split("/").pop();
				const result = await callSupabase(env, `/rest/v1/users?id=eq.${id}`);
				return successResponse(result, "User fetched successfully");
			}

			if (url.pathname.startsWith("/api/users/") && request.method === "PATCH") {
				const id = url.pathname.split("/").pop();
				const body = await getBody(request);

				if (!body) {
					return errorResponse("Invalid or empty JSON body", 400);
				}
				const existingUser = await callSupabase(
					env,
					`/rest/v1/users?id=eq.${id}&select=*`
				);
				const normalizedBody = normalizeUserWritePayload(
					body,
					existingUser?.[0]
				);
				const result = await callSupabase(env, `/rest/v1/users?id=eq.${id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(normalizedBody)
				});
				return successResponse(result, "User updated successfully");
			}
			if (url.pathname === "/api/users/2fa/setup" && request.method === "POST") {
				const body = (await request.json()) as LoginBody;
				if (!body || !body.email) {
					return errorResponse("Email required");
				}

				// get user
				const res = await fetch(
					`${env.SUPABASE_URL}/rest/v1/users?email=eq.${body.email}`,
					{
						headers: {
							apikey: env.SUPABASE_KEY,
							Authorization: `Bearer ${env.SUPABASE_KEY}`
						}
					}
				);

				const text = await res.text();
				let users;

				try {
					users = JSON.parse(text);
				} catch {
					return errorResponse("Invalid DB response", 500);
				}

				if (!users || users.length === 0) {
					return errorResponse("User not found", 404);
				}

				const user = users[0];

				if (getUserTwoFactorEnabled(user)) {
					return errorResponse("2FA already enabled", 400);
				}

				// generate secret
				const secret = authenticator.generateSecret();

				const otpauth_url = authenticator.keyuri(
					user.email,
					"Heart Fuel",
					secret
				);

				const secretColumn = getExistingColumnName(
					user,
					TWO_FACTOR_SECRET_KEYS,
					"twofactorsecret"
				);

				// save secret
				const updateRes = await fetch(
					`${env.SUPABASE_URL}/rest/v1/users?id=eq.${user.id}`,
					{
						method: "PATCH",
						headers: {
							apikey: env.SUPABASE_KEY,
							Authorization: `Bearer ${env.SUPABASE_KEY}`,
							"Content-Type": "application/json",
							"Prefer": "return=representation"
						},
						body: JSON.stringify({
							[secretColumn]: secret
						})
					}
				);

				const updateText = await updateRes.text();

				if (!updateText) {
					return errorResponse("Failed to save 2FA secret (empty response)", 500);
				}

				let updatedUser;
				try {
					updatedUser = JSON.parse(updateText);
				} catch {
					return errorResponse("Invalid DB response while saving 2FA", 500);
				}

				if (!updateRes.ok) {
					const message =
						typeof updatedUser?.message === "string"
							? updatedUser.message
							: JSON.stringify(updatedUser);
					return errorResponse(`Failed to save 2FA secret: ${message}`, updateRes.status);
				}

				if (!Array.isArray(updatedUser) || updatedUser.length === 0) {
					return errorResponse("2FA secret not saved in DB", 500);
				}

				if (!getUserTwoFactorSecret(updatedUser[0])) {
					return errorResponse(
						`2FA secret was not saved. Check Supabase column name (${secretColumn}).`,
						500
					);
				}

				return jsonResponse({
					message: "Scan QR in Google Authenticator",
					data: {
						secret: secret,
						otpauth_url: otpauth_url
					}
				});
			}
			if (url.pathname === "/api/users/2fa/verify-setup" && request.method === "POST") {
				const body = (await request.json()) as LoginBody;
				if (!body || !body.email || !body.token) {
					return errorResponse("Email and token required");
				}

				const res = await fetch(
					`${env.SUPABASE_URL}/rest/v1/users?email=eq.${body.email}`,
					{
						headers: {
							apikey: env.SUPABASE_KEY,
							Authorization: `Bearer ${env.SUPABASE_KEY}`
						}
					}
				);

				const text = await res.text();
				let users;

				try {
					users = JSON.parse(text);
				} catch {
					return errorResponse("Invalid DB response", 500);
				}

				if (!users || users.length === 0) {
					return errorResponse("User not found", 404);
				}

				const user = users[0];

				const twoFactorSecret = getUserTwoFactorSecret(user);

				if (!twoFactorSecret) {
					return errorResponse("2FA not started", 400);
				}


				const verified = authenticator.check(
					String(body.token),
					twoFactorSecret
				);

				if (!verified) {
					return errorResponse("Invalid code", 400);
				}

				const enabledColumn = getExistingColumnName(
					user,
					TWO_FACTOR_ENABLED_KEYS,
					"twofactorenabled"
				);

				// enable 2FA
				await callSupabase(
					env,
					`/rest/v1/users?id=eq.${user.id}`,
					{
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							[enabledColumn]: true
						})
					}
				);

				if (!env.JWT_SECRET || typeof env.JWT_SECRET !== "string") {
					return errorResponse("JWT_SECRET invalid", 500);
				}
				const secret = new TextEncoder().encode(env.JWT_SECRET);

				const token = await new SignJWT({ id: user.id, role: user.role })
					.setProtectedHeader({ alg: "HS256" })
					.setExpirationTime("7d")
					.sign(secret);

				return successResponse(
					{ token },
					"2FA enabled"
				);
			}

			if (url.pathname === "/api/users/2fa/reset" && request.method === "POST") {
				const admin = await verifyAdmin(request, env);

				if (!admin) {
					return errorResponse("Unauthorized", 401);
				}

				if (admin.role !== "admin" && admin.role !== "super_admin") {
					return errorResponse("Only admin can reset 2FA", 403);
				}

				const body = (await request.json()) as { email: string };

				if (!body?.email) {
					return errorResponse("Email required", 400);
				}

				const users = await callSupabase(
					env,
					`/rest/v1/users?email=eq.${encodeURIComponent(body.email)}`
				);

				if (!users || users.length === 0) {
					return errorResponse("User not found", 404);
				}

				const user = users[0];
				const secret = authenticator.generateSecret();
				const otpauth_url = authenticator.keyuri(
					user.email,
					"Heart Fuel",
					secret
				);
				const secretColumn = getExistingColumnName(
					user,
					TWO_FACTOR_SECRET_KEYS,
					"twofactorsecret"
				);
				const enabledColumn = getExistingColumnName(
					user,
					TWO_FACTOR_ENABLED_KEYS,
					"twofactorenabled"
				);

				await callSupabase(
					env,
					`/rest/v1/users?id=eq.${user.id}`,
					{
						method: "PATCH",
						headers: {
							"Content-Type": "application/json",
							"Prefer": "return=representation"
						},
						body: JSON.stringify({
							[secretColumn]: secret,
							[enabledColumn]: false // IMPORTANT
						})
					}
				);

				return successResponse(
					{
						email: user.email,
						secret,
						otpauth_url
					},
					"2FA reset successfully. Verify again using /api/users/2fa/verify-setup"
				);
			}
			// ================= Donation Causes APIs ================= 

			if (
				url.pathname === "/api/causes" &&
				request.method === "GET"
			) {
				const result = await callSupabase(
					env,
					"/rest/v1/donation_causes?select=*"
				);

				return successResponse(
					result,
					"Causes fetched successfully"
				);
			}
			if (
				url.pathname.startsWith("/api/causes/") &&
				request.method === "GET"
			) {
				const id = url.pathname.split("/").pop();

				const result = await callSupabase(
					env,
					`/rest/v1/donation_causes?id=eq.${id}`
				);

				return successResponse(
					result,
					"Cause fetched successfully"
				);
			}
			if (
				url.pathname === "/api/causes" &&
				request.method === "POST"
			) {
				const body =
					await getBody(request);

				if (!body) {
					return errorResponse(
						"Invalid body"
					);
				}

				const payload = {
					...body,
					images: body.images || [],
					videos: body.videos || []
				};

				const result =
					await callSupabase(
						env,
						"/rest/v1/donation_causes",
						{
							method: "POST",
							headers: {
								"Content-Type":
									"application/json",
								Prefer:
									"return=representation"
							},
							body: JSON.stringify(
								payload
							)
						}
					);

				return successResponse(
					result,
					"Cause created successfully"
				);
			}
			if (
				url.pathname.startsWith("/api/causes/") &&
				request.method === "PATCH"
			) {
				const id =
					url.pathname.split("/").pop();

				const body =
					await getBody(request);

				const result =
					await callSupabase(
						env,
						`/rest/v1/donation_causes?id=eq.${id}`,
						{
							method: "PATCH",
							headers: {
								"Content-Type":
									"application/json",
								Prefer:
									"return=representation"
							},
							body: JSON.stringify(
								body
							)
						}
					);

				return successResponse(
					result,
					"Cause updated successfully"
				);
			}
			if (
				url.pathname.startsWith("/api/causes/") &&
				request.method === "DELETE"
			) {
				const id =
					url.pathname.split("/").pop();

				const existing =
					await callSupabase(
						env,
						`/rest/v1/donation_causes?id=eq.${id}&select=*`
					);

				const cause =
					existing?.[0];

				if (!cause) {
					return errorResponse(
						"Cause not found",
						404
					);
				}

				await callSupabase(
					env,
					`/rest/v1/donation_causes?id=eq.${id}`,
					{
						method: "DELETE"
					}
				);

				if (cause.images?.length) {
					await deleteImagesFromStorage(
						env,
						cause.images
					);
				}

				if (cause.videos?.length) {
					await deleteVideosFromStorage(
						env,
						cause.videos
					);
				}

				return successResponse(
					null,
					"Cause deleted successfully"
				);
			}

			// ================= PAYMENT SETTINGS =================


			if (
				url.pathname === "/api/payment-settings" &&
				request.method === "GET"
			) {
				const result = await callSupabase(
					env,
					"/rest/v1/payment_settings?select=*"
				);

				return successResponse(
					result,
					"Payment settings fetched successfully"
				);
			}
			if (
				url.pathname.startsWith("/api/payment-settings/") &&
				request.method === "GET"
			) {
				const id = url.pathname.split("/").pop();

				const result = await callSupabase(
					env,
					`/rest/v1/payment_settings?id=eq.${id}`
				);

				return successResponse(
					result,
					"Payment setting fetched successfully"
				);
			}
			if (
				url.pathname === "/api/payment-settings" &&
				request.method === "POST"
			) {
				const body = await getBody(request);

				if (!body) {
					return errorResponse(
						"Invalid or empty JSON body",
						400
					);
				}

				const result = await callSupabase(
					env,
					"/rest/v1/payment_settings",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Prefer: "return=representation"
						},
						body: JSON.stringify(body)
					}
				);

				return successResponse(
					result,
					"Payment setting created successfully"
				);
			}
			if (
				url.pathname.startsWith("/api/payment-settings/") &&
				request.method === "PATCH"
			) {
				const id = url.pathname.split("/").pop();

				const body = await getBody(request);

				if (!body) {
					return errorResponse(
						"Invalid or empty JSON body",
						400
					);
				}

				const payload = {
					...body,
					updated_at: new Date().toISOString()
				};

				const result = await callSupabase(
					env,
					`/rest/v1/payment_settings?id=eq.${id}`,
					{
						method: "PATCH",
						headers: {
							"Content-Type": "application/json",
							Prefer: "return=representation"
						},
						body: JSON.stringify(payload)
					}
				);

				return successResponse(
					result,
					"Payment setting updated successfully"
				);
			}
			if (
				url.pathname.startsWith("/api/payment-settings/") &&
				request.method === "DELETE"
			) {
				const id = url.pathname.split("/").pop();

				const existing = await callSupabase(
					env,
					`/rest/v1/payment_settings?id=eq.${id}&select=*`
				);

				const payment = existing?.[0];

				if (!payment) {
					return errorResponse(
						"Payment setting not found",
						404
					);
				}

				await callSupabase(
					env,
					`/rest/v1/payment_settings?id=eq.${id}`,
					{
						method: "DELETE"
					}
				);

				if (payment.qr_image) {
					await deleteImagesFromStorage(
						env,
						[payment.qr_image]
					);
				}

				return successResponse(
					null,
					"Payment setting deleted successfully"
				);
			}
			// ================= SITE CONTENT =================

			const siteContentTable = getSiteContentTable(url.pathname);
			if (siteContentTable) {
				const siteContentPath = `/rest/v1/${siteContentTable}?key=eq.main`;

				if (request.method === "GET") {
					const result = await callSupabase(env, `${siteContentPath}&select=*`);
					return successResponse(result, "Site content fetched successfully");
				}

				if (request.method === "POST") {
					const body = await getBody(request);

					if (!body) {
						return errorResponse("Invalid or empty JSON body", 400);
					}

					const result = await callSupabase(env, `/rest/v1/${siteContentTable}`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Prefer": "resolution=merge-duplicates,return=representation"
						},
						body: JSON.stringify({
							key: "main",
							...(body as Record<string, any>)
						})
					});
					return successResponse(result, "Site content created successfully");
				}

				if (["PUT", "PATCH"].includes(request.method)) {
					const body = await getBody(request);

					if (!body) {
						return errorResponse("Invalid or empty JSON body", 400);
					}
					const result = await callSupabase(env, siteContentPath, {
						method: "PATCH",
						headers: {
							"Content-Type": "application/json",
							"Prefer": "return=representation"
						},
						body: JSON.stringify(body)
					});
					return successResponse(result, "Site content updated successfully");
				}

				if (request.method === "DELETE") {
					const result = await callSupabase(env, siteContentPath, {
						method: "DELETE",
						headers: {
							"Prefer": "return=representation"
						}
					});
					return successResponse(result, "Site content deleted successfully");
				}
			}
			return errorResponse("Not Found", 404);

		} catch (err: any) {
			console.error("Unhandled error", err);
			if (err instanceof SupabaseRequestError) {
				return errorResponse(err.message, err.status);
			}

			return errorResponse("Unhandled error: " + err.message, 500);
		}
	}
};
