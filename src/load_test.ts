import http from 'http';

interface BenchmarkResult {
  name: string;
  url: string;
  concurrency: number;
  totalRequests: number;
  successful: number;
  failed: number;
  totalTimeMs: number;
  avgTimeMs: number;
  minTimeMs: number;
  maxTimeMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  rps: number;
}

function makeRequest(url: string, headers: Record<string, string> = {}): Promise<{ status: number; duration: number; size: number }> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const parsedUrl = new URL(url);

    const req = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 4000,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
        });
        res.on('end', () => {
          const end = process.hrtime.bigint();
          const duration = Number(end - start) / 1_000_000;
          resolve({ status: res.statusCode || 0, duration, size });
        });
      }
    );

    req.on('error', () => {
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1_000_000;
      resolve({ status: 500, duration, size: 0 });
    });

    req.end();
  });
}

async function runBenchmark(
  name: string,
  url: string,
  concurrency: number,
  totalRequests: number,
  headers: Record<string, string> = {}
): Promise<BenchmarkResult> {
  const durations: number[] = [];
  let successful = 0;
  let failed = 0;
  let inFlight = 0;
  let completed = 0;
  let started = 0;

  const benchmarkStart = Date.now();

  return new Promise((resolve) => {
    function launchNext() {
      if (completed >= totalRequests) {
        const totalTimeMs = Date.now() - benchmarkStart;
        durations.sort((a, b) => a - b);
        const sum = durations.reduce((a, b) => a + b, 0);
        const avgTimeMs = sum / (durations.length || 1);
        const p50Ms = durations[Math.floor(durations.length * 0.5)] || 0;
        const p95Ms = durations[Math.floor(durations.length * 0.95)] || 0;
        const p99Ms = durations[Math.floor(durations.length * 0.99)] || 0;
        const minTimeMs = durations[0] || 0;
        const maxTimeMs = durations[durations.length - 1] || 0;
        const rps = (successful / (totalTimeMs / 1000));

        resolve({
          name,
          url,
          concurrency,
          totalRequests,
          successful,
          failed,
          totalTimeMs,
          avgTimeMs: Number(avgTimeMs.toFixed(2)),
          minTimeMs: Number(minTimeMs.toFixed(2)),
          maxTimeMs: Number(maxTimeMs.toFixed(2)),
          p50Ms: Number(p50Ms.toFixed(2)),
          p95Ms: Number(p95Ms.toFixed(2)),
          p99Ms: Number(p99Ms.toFixed(2)),
          rps: Number(rps.toFixed(2)),
        });
        return;
      }

      while (inFlight < concurrency && started < totalRequests) {
        started++;
        inFlight++;
        makeRequest(url, headers).then((res) => {
          inFlight--;
          completed++;
          if (res.status >= 200 && res.status < 400) {
            successful++;
            durations.push(res.duration);
          } else {
            failed++;
          }
          launchNext();
        });
      }
    }

    launchNext();
  });
}

async function main() {
  console.log('========================================================================');
  console.log('BHOJMITRA LOAD TESTING & PERFORMANCE BENCHMARK SUITE');
  console.log('Testing Concurrency: 1, 10, 50, 100 concurrent requests');
  console.log('========================================================================\n');

  const targets = [
    { name: 'Health Check API', url: 'http://localhost:4000/api/health' },
    { name: 'Admin Dashboard Stats', url: 'http://localhost:4000/api/admin/dashboard/stats' },
    { name: 'Admin Restaurants List', url: 'http://localhost:4000/api/admin/restaurants' },
    { name: 'Admin Subscriptions List', url: 'http://localhost:4000/api/admin/subscriptions' },
    { name: 'Admin Users List', url: 'http://localhost:4000/api/admin/users' },
    { name: 'Admin Branches List', url: 'http://localhost:4000/api/admin/branches' },
    { name: 'Admin Activity Logs', url: 'http://localhost:4000/api/admin/activity-logs' },
    { name: 'Admin Leads API', url: 'http://localhost:4000/api/admin/leads' },
    { name: 'Admin Web Visitors', url: 'http://localhost:4000/api/admin/website/visitors' },
  ];

  const concurrencies = [1, 10, 50, 100];
  const allResults: BenchmarkResult[] = [];

  for (const target of targets) {
    console.log(`\n▶ Benchmarking: ${target.name} (${target.url})`);
    console.log('------------------------------------------------------------------------');
    console.log('Conc | Requests | Success | Failed | Avg (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Req/Sec');
    console.log('------------------------------------------------------------------------');

    for (const c of concurrencies) {
      const totalReqs = c === 1 ? 20 : c === 10 ? 50 : c === 50 ? 100 : 200;
      const res = await runBenchmark(target.name, target.url, c, totalReqs);
      allResults.push(res);
      console.log(
        `${res.concurrency.toString().padEnd(4)} | ` +
        `${res.totalRequests.toString().padEnd(8)} | ` +
        `${res.successful.toString().padEnd(7)} | ` +
        `${res.failed.toString().padEnd(6)} | ` +
        `${res.avgTimeMs.toFixed(1).padStart(8)} | ` +
        `${res.p50Ms.toFixed(1).padStart(8)} | ` +
        `${res.p95Ms.toFixed(1).padStart(8)} | ` +
        `${res.p99Ms.toFixed(1).padStart(8)} | ` +
        `${res.rps.toFixed(1).padStart(7)}`
      );
    }
  }

  console.log('\n========================================================================');
  console.log('BENCHMARK COMPLETE');
  console.log('========================================================================');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
