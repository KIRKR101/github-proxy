import { Env } from "./types";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

const MIN_YEAR = 2024;
const CACHE_TTL_SECONDS = 3600;

function jsonResponse(data: unknown, status = 200, cacheable = false) {
    const headers: Record<string, string> = { ...CORS_HEADERS };
    if (cacheable) {
        headers["Cache-Control"] = `public, max-age=${CACHE_TTL_SECONDS}`;
    }
    return Response.json(data, {
        status,
        headers,
    });
}

async function handleContributions(
    url: URL,
    token: string,
    username: string,
): Promise<Response> {
    const currentYear = new Date().getFullYear();
    const yearParam = url.searchParams.get("year");
    let year: number;

    if (yearParam !== null) {
        year = parseInt(yearParam, 10);
        if (isNaN(year) || year < MIN_YEAR || year > currentYear) {
            return jsonResponse(
                {
                    error: `Year must be between ${MIN_YEAR} and ${currentYear}`,
                },
                400,
            );
        }
    } else {
        year = currentYear;
    }

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

        const calendar =
            result.data.user.contributionsCollection.contributionCalendar;

        return jsonResponse(
            {
                contributions: {
                    year,
                    totalContributions: calendar.totalContributions,
                    weeks: calendar.weeks,
                },
            },
            200,
            true,
        );
    } catch (err) {
        console.error("Worker error:", err);
        return jsonResponse({ contributions: null });
    }
}

async function handleLastCommit(
    token: string,
    username: string,
): Promise<Response> {
    const query = `
		query {
			user(login: "${username}") {
				repositories(
					first: 100
					ownerAffiliations: OWNER
					isFork: false
					orderBy: { field: PUSHED_AT, direction: DESC }
				) {
					nodes {
						name
						url
						defaultBranchRef {
							target {
								... on Commit {
									committedDate
								}
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
            return jsonResponse({ repositories: null });
        }

        const result: {
            errors?: { message: string }[];
            data?: {
                user: {
                    repositories: {
                        nodes: {
                            name: string;
                            url: string;
                            defaultBranchRef: {
                                target: { committedDate: string } | null;
                            } | null;
                        }[];
                    };
                };
            };
        } = await res.json();

        if (result.errors || !result.data) {
            console.error("GitHub GraphQL errors:", result.errors);
            return jsonResponse({ repositories: null });
        }

        const repositories = result.data.user.repositories.nodes.map(
            (repo) => ({
                name: repo.name,
                url: repo.url,
                lastCommitDate: repo.defaultBranchRef?.target?.committedDate ?? null,
            }),
        );

        return jsonResponse({ repositories }, 200, true);
    } catch (err) {
        console.error("Worker error:", err);
        return jsonResponse({ repositories: null });
    }
}

export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<Response> {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (request.method !== "GET") {
            return new Response("Not Found", {
                status: 404,
                headers: CORS_HEADERS,
            });
        }

        const url = new URL(request.url);

        // Normalise so both share one cache key space and one routing branch below
        if (url.pathname === "/") {
            url.pathname = "/api/contributions";
        }

        const isCacheable =
            url.pathname === "/api/contributions" ||
            url.pathname === "/api/last-commit";

        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request);

        if (isCacheable) {
            const cached = await cache.match(cacheKey);
            if (cached) {
                return cached;
            }
        }

        const token = env.GITHUB_TOKEN;
        const username = env.GITHUB_USERNAME || "Kirkr101";

        let response: Response;

        if (!token) {
            response =
                url.pathname === "/api/last-commit"
                    ? jsonResponse({ repositories: null })
                    : jsonResponse({ contributions: null });
        } else {
            switch (url.pathname) {
                case "/api/contributions":
                    response = await handleContributions(url, token, username);
                    break;
                case "/api/last-commit":
                    response = await handleLastCommit(token, username);
                    break;
                default:
                    response = new Response("Not Found", {
                        status: 404,
                        headers: CORS_HEADERS,
                    });
            }
        }

        if (isCacheable && response.headers.has("Cache-Control")) {
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
        }

        return response;
    },
} satisfies ExportedHandler<Env>;
