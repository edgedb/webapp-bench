#!/usr/bin/env python3

#
# Copyright (c) 2019 MagicStack Inc.
# All rights reserved.
#
# See LICENSE for details.
##


import asyncio
import concurrent.futures as futures
import json
import math
import multiprocessing
import random
import time
import typing

import numpy as np
import uvloop

import _shared


class Result(typing.NamedTuple):

    benchmark: str
    queryname: str
    nqueries: int
    duration: int
    min_latency: int
    max_latency: int
    latency_stats: typing.List[int]


def run_benchmark_method(ctx, benchname, ids, queryname):
    queries_mod = _shared.BENCHMARKS[benchname].module
    if hasattr(queries_mod, 'init'):
        queries_mod.init(ctx)

    method = getattr(queries_mod, queryname)
    conn = queries_mod.connect(ctx)

    try:
        nqueries = 0
        latency_stats = np.zeros((math.ceil(ctx.timeout) * 100 * 1000 + 1,))
        min_latency = float('inf')
        max_latency = 0.0

        duration = ctx.warmup_time
        start = time.monotonic()
        while time.monotonic() - start < duration:
            rid = random.choice(ids)
            method(conn, rid)

        duration = ctx.duration
        start = time.monotonic()
        max_req_time = len(latency_stats) - 1
        while time.monotonic() - start < duration:
            rid = random.choice(ids)
            req_start = time.monotonic_ns()
            method(conn, rid)
            req_time = (time.monotonic_ns() - req_start) // 10000

            if req_time > max_latency:
                max_latency = req_time
            if req_time < min_latency:
                min_latency = req_time

            if req_time > max_req_time:
                req_time = max_req_time
            latency_stats[req_time] += 1

            nqueries += 1

        return nqueries, latency_stats, min_latency, max_latency
    finally:
        queries_mod.close(ctx, conn)


async def run_async_benchmark_method(ctx, benchname, ids, queryname):
    queries_mod = _shared.BENCHMARKS[benchname].module
    if hasattr(queries_mod, 'init'):
        queries_mod.init(ctx)

    method = getattr(queries_mod, queryname)
    conn = await queries_mod.connect(ctx)

    try:
        nqueries = 0
        latency_stats = np.zeros((math.ceil(ctx.timeout) * 100 * 1000 + 1,))
        min_latency = float('inf')
        max_latency = 0.0

        duration = ctx.warmup_time
        start = time.monotonic()
        while time.monotonic() - start < duration:
            rid = random.choice(ids)
            await method(conn, rid)

        duration = ctx.duration
        start = time.monotonic()
        max_req_time = len(latency_stats) - 1
        while time.monotonic() - start < duration:
            rid = random.choice(ids)
            req_start = time.monotonic_ns()
            await method(conn, rid)
            req_time = (time.monotonic_ns() - req_start) // 10000

            if req_time > max_latency:
                max_latency = req_time
            if req_time < min_latency:
                min_latency = req_time

            if req_time > max_req_time:
                req_time = max_req_time
            latency_stats[req_time] += 1

            nqueries += 1

        return nqueries, latency_stats, min_latency, max_latency
    finally:
        await queries_mod.close(ctx, conn)


def agg_results(results, benchname, queryname, duration) -> Result:
    min_latency = float('inf')
    max_latency = 0.0
    nqueries = 0
    latency_stats = None
    for result in results:
        t_nqueries, t_latency_stats, t_min_latency, t_max_latency = result
        nqueries += t_nqueries
        if latency_stats is None:
            latency_stats = t_latency_stats
        else:
            latency_stats = np.add(latency_stats, t_latency_stats)
        if t_max_latency > max_latency:
            max_latency = t_max_latency
        if t_min_latency < min_latency:
            min_latency = t_min_latency

    return Result(
        benchmark=benchname,
        queryname=queryname,
        nqueries=nqueries,
        duration=duration,
        min_latency=min_latency,
        max_latency=max_latency,
        latency_stats=latency_stats,
    )


def run_benchmark_sync(ctx, benchname, duration, ids, queryname) -> Result:
    method_ids = ids[queryname]

    with futures.ProcessPoolExecutor(max_workers=ctx.concurrency) as e:
        tasks = []
        for i in range(ctx.concurrency):
            task = e.submit(
                run_benchmark_method,
                ctx,
                benchname,
                method_ids,
                queryname)
            tasks.append(task)

        results = [fut.result() for fut in futures.wait(tasks).done]

    return agg_results(results, benchname, queryname, duration)


async def run_benchmark_async(ctx, benchname, duration,
                              ids, queryname) -> Result:
    method_ids = ids[queryname]

    tasks = []
    for i in range(ctx.concurrency):
        task = asyncio.create_task(
            run_async_benchmark_method(
                ctx,
                benchname,
                method_ids,
                queryname))
        tasks.append(task)

    results = await asyncio.gather(*tasks)
    return agg_results(results, benchname, queryname, duration)


def run_sync(ctx, benchname) -> typing.List[Result]:
    queries_mod = _shared.BENCHMARKS[benchname].module
    results = []

    idconn = queries_mod.connect(ctx)
    try:
        ids = queries_mod.load_ids(ctx, idconn)
    finally:
        queries_mod.close(ctx, idconn)

    for queryname in ctx.queries:
        res = run_benchmark_sync(
            ctx, benchname, ctx.duration, ids, queryname)
        results.append(res)
        print_result(ctx, res)

    return results


async def run_async(ctx, benchname) -> typing.List[Result]:
    queries_mod = _shared.BENCHMARKS[benchname].module
    results = []

    idconn = await queries_mod.connect(ctx)
    try:
        ids = await queries_mod.load_ids(ctx, idconn)
    finally:
        await queries_mod.close(ctx, idconn)

    for queryname in ctx.queries:
        res = await run_benchmark_async(
            ctx, benchname, ctx.duration, ids, queryname)
        results.append(res)
        print_result(ctx, res)

    return results


def run_bench(ctx, benchname) -> typing.List[Result]:
    queries_mod = _shared.BENCHMARKS[benchname].module
    if getattr(queries_mod, 'ASYNC', False):
        return asyncio.run(run_async(ctx, benchname))
    else:
        return run_sync(ctx, benchname)


def print_result(ctx, result: Result):
    print(f'== {result.benchmark} : {result.queryname} ==')
    print(f'queries:\t{result.nqueries}')
    print(f'qps:\t\t{result.nqueries // ctx.duration} q/s')
    print(f'min latency:\t{result.min_latency / 100:.2f}ms')
    print(f'max latency:\t{result.max_latency / 100:.2f}ms')
    print()


def main():
    uvloop.install()
    multiprocessing.set_start_method('spawn')

    ctx, _ = _shared.parse_args(
        prog_desc='EdgeDB Databases Benchmark (Python drivers)',
        out_to_json=True)

    print('============ Python ============')
    print(f'concurrency:\t{ctx.concurrency}')
    print(f'warmup time:\t{ctx.warmup_time} seconds')
    print(f'duration:\t{ctx.duration} seconds')
    print(f'queries:\t{", ".join(q for q in ctx.queries)}')
    print(f'benchmarks:\t{", ".join(b for b in ctx.benchmarks)}')
    print()

    data = []
    for benchmark in ctx.benchmarks:
        bench_desc = _shared.BENCHMARKS[benchmark]
        if bench_desc.language != 'python':
            continue

        res = run_bench(ctx, benchmark)
        data.append(res)

    if ctx.json:
        json_data = []
        for results in data:
            json_results = []
            for r in results:
                json_results.append({
                    'queryname': r.queryname,
                    'nqueries': r.nqueries,
                    'min_latency': r.min_latency,
                    'max_latency': r.max_latency,
                    'latency_stats': [int(i) for i in r.latency_stats.tolist()]
                })
            json_data.append({
                'benchmark': results[0].benchmark,
                'duration': results[0].duration,
                'queries': json_results,
            })

        data = json.dumps({
            'language': 'python',
            'concurrency': ctx.concurrency,
            'warmup_time': ctx.warmup_time,
            'duration': ctx.duration,
            'data': json_data,
        })
        with open(ctx.json, 'wt') as f:
            f.write(data)


if __name__ == '__main__':
    main()
