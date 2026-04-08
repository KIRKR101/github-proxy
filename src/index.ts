import { Env } from "./types";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200) {
    return Response.json(data, {
        status,
        headers: CORS_HEADERS,
    });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const url = new URL(request.url);

        if (url.pathname !== "/" || request.method !== "GET") {
            return new Response("Not Found", {
                status: 404,
                headers: CORS_HEADERS,
            });
        }

        const token = env.GITHUB_TOKEN;
        const username = env.GITHUB_USERNAME || "Kirkr101";

        if (!token) {
            return jsonResponse({ contributions: null });
        }

        const now = new Date();
        const year = now.getFullYear();
        const startDate = `${year}-01-01T00:00:00Z`;
        const endDate = `${year}-12-31T23:59:59Z`;

        const query = `
			query {
				user(login: "${username}") {
					contributionsCollection(from: "${startDate}", to: "${endDate}") {
						contributionCalendar {
							totalContributions
							weeks {
								contributionDays {
									date
									contributionCount
									color
								}
							}
						}
					}
				}
			}
		`;

        try {
            const res = await fetch("https://api.github.com/graphql", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "User-Agent": "Cloudflare-Worker",
                },
                body: JSON.stringify({ query }),
            });

            if (!res.ok) {
                const errText = await res.text();
                console.error(`GitHub API error (${res.status}):`, errText);
                return jsonResponse({ contributions: null });
            }

            const result: {
                errors?: { message: string }[];
                data?: {
                    user: {
                        contributionsCollection: {
                            contributionCalendar: {
                                totalContributions: number;
                                weeks: {
                                    contributionDays: {
                                        date: string;
                                        contributionCount: number;
                                        color: string;
                                    }[];
                                }[];
                            };
                        };
                    };
                };
            } = await res.json();

            if (result.errors || !result.data) {
                console.error("GitHub GraphQL errors:", result.errors);
                return jsonResponse({ contributions: null });
            }

            const calendar = result.data.user.contributionsCollection.contributionCalendar;

            return jsonResponse({
                contributions: {
                    totalContributions: calendar.totalContributions,
                    weeks: calendar.weeks,
                },
            });
        } catch (err) {
            console.error("Worker error:", err);
            return jsonResponse({ contributions: null });
        }
    },
} satisfies ExportedHandler<Env>;
