# Aurora DSQL Cost Estimation Workflow

Agent-facing guide for estimating Aurora DSQL costs. Load [pricing-and-formulas.md](pricing-and-formulas.md) for detailed pricing data and calculation formulas.

## Quick Reference

**Most important:** Always query `awspricing` first - pricing varies 25% across regions.

**For pre-deployment estimates (no cluster yet):**

1. Collect: Region, Read TPS, Write TPS, Data Size (GB)
2. Query `awspricing` for region-specific DPU + Storage pricing
3. Use Default DPU Values from [pricing-and-formulas.md](pricing-and-formulas.md) if customer has no EXPLAIN ANALYZE data
4. Calculate monthly costs using formulas

**For existing clusters:**

1. Run MCP queries (see [MCP Tool Integration](#mcp-tool-integration)) to gather actual workload stats
2. Use EXPLAIN ANALYZE to get real DPU consumption per query
3. Calculate costs using measured values

**For more accurate estimates with actual queries:**

Use the [DSQL Playground Cost Estimator](https://playground.dsql.demo.aws/) to test queries on a real cluster. Pin queries to get DPU estimates based on actual execution. More accurate than formulas alone, especially for complex queries. Includes free tier (100K DPUs/month) calculation.

---

## Cost Estimation Workflow

### Phase 0: Understand Schema Context and Collect Region

**ALWAYS start by asking for region AND schema context:**

1. **"Which AWS region are you planning to deploy in?"** (e.g., us-east-1, eu-west-1, ap-northeast-1)
2. **Query `awspricing` immediately** to get current DPU and Storage pricing for that region
3. **"Do you have existing schemas and query patterns you'd like to cost out, or would you like help designing an optimal DSQL schema first?"**

**If they have existing schemas:**

1. Ask them to share:
   - Table schemas (CREATE TABLE statements)
   - Top 5-10 most frequent queries
   - Current database type (MySQL, PostgreSQL, etc.)
2. Offer to help translate and optimize for DSQL:
   - "Would you like me to translate these to DSQL-optimized schemas?"
   - "I can suggest index improvements to reduce costs"
3. Analyze their queries to determine:
   - Actual rows scanned per query
   - Index usage patterns
   - Missing indexes that cause table scans

**If they need help designing schemas:**

1. Ask about their use case:
   - "What kind of application are you building?"
   - "Multi-tenant SaaS, e-commerce, IoT, social platform, etc.?"
2. Design DSQL-optimized schemas with proper indexes
3. Generate realistic query patterns for their use case
4. Calculate costs based on the optimized design

### Phase 1: Gather Workload Metrics

After understanding their schema context, collect:

**Essential:**

1. **Average Read TPS** (or expected queries per second)
2. **Average Write TPS** (or expected writes per second)
3. **Data size** (current or projected in GB)

**From Schema Analysis:**

1. **Number of tables** (from their schemas or design)
2. **Number of indexes** (from their schemas or optimized design)
3. **Average rows scanned per query** (analyze their actual queries)
4. **Average rows changed per write** (from their write patterns)

### Phase 2: Calculate Accurate Costs

Use the gathered schema and query information to calculate:

- **Read DPUs** (based on actual query scan patterns)
- **Write DPUs** (based on index count and write patterns)
- **Compute DPUs** (transaction overhead)
- **Storage costs** (data + indexes)

See [pricing-and-formulas.md](pricing-and-formulas.md) for calculation formulas and default values.

### Phase 3: Provide Recommendations

Based on calculated costs:

- Highlight the largest cost driver
- Suggest specific optimizations:
  - Missing indexes (if analyzing existing schemas)
  - Query rewrites to reduce scans
  - Schema denormalization opportunities
- Show cost impact of each optimization
- Compare against their current database costs if available

---

## Required Inputs for Cost Estimation

### Region Selection

- **AWS Region**: Target deployment region (e.g., us-east-1, eu-west-1, ap-northeast-1)
  - **MUST be collected FIRST** before calculating costs
  - Query `awspricing` MCP server for region-specific DPU and Storage pricing

### General Cluster Characteristics

- **Number of shards**: Cluster parallelism (default: 11 for small workloads)
- **Number of tables**: Schema complexity
- **Number of indexes**: Total across all tables
- **Average indexes per table**: Index density (typically 3-5)
- **Average row size (bytes)**: Including all columns
- **Total rows**: Current or projected row count
- **Data size per partition (TB)**: Raw data per shard
- **Index size per partition (TB)**: Index data per shard

### Write Workload Characteristics

- **Average Write TPS**: Transactions per second (INSERT/UPDATE/DELETE)
- **Rows changed per transaction**: Typical batch size
- **Average write statement size (bytes)**: Payload size per statement (default: 128)
- **Average index statements per write**: Indexes updated (default: avg indexes per table)
- **Average index statement size (bytes)**: Index update payload (default: 128)
- **Commit latency for writes (ms)**: Transaction overhead (default: 26ms)

### Read Workload Characteristics

- **Average Read TPS**: SELECT queries per second
- **Read statements per transaction**: Queries per transaction (default: 1-2)
- **Average rows scanned per SELECT**: Query scan size
- **Average rows returned per SELECT**: Result set size
- **Average row size (bytes)**: For reads
- **Secondary index lookups per SELECT**: Index access count (default: 2)
- **Average index lookup size (bytes)**: Index payload (default: 128)
- **Commit latency for reads (ms)**: Transaction overhead (default: 3ms)

---

## Cost Optimization Strategies

### 1. Reduce Read DPUs

- **Add indexes** for frequently scanned columns
- **Minimize rows scanned** with precise WHERE clauses
- **Use covering indexes** to avoid table lookups
- **Partition large tables** by tenant_id or date

### 2. Reduce Write DPUs

- **Batch writes** (up to 3,000 rows per transaction)
- **Reduce index count** (only create necessary indexes)
- **Use async indexes** (`CREATE INDEX ASYNC`)
- **Optimize row size** by storing large data externally (S3)

### 3. Reduce Storage Costs

- **Archive old data** to S3 with lifecycle policies
- **Compress large columns** (JSON, TEXT)
- **Drop unused indexes**
- **Use appropriate data types** (SMALLINT vs BIGINT)

### 4. Right-Size Compute

- **Monitor actual latency** (may be lower than defaults)
- **Optimize transaction scope** (fewer statements per txn)
- **Use connection pooling** to reduce connection overhead

---

## MCP Tool Integration

When connected to a DSQL cluster, use these queries to gather actual workload data:

### Get Table Statistics

```sql
SELECT 
  schemaname,
  tablename,
  n_tup_ins AS inserts,
  n_tup_upd AS updates,
  n_tup_del AS deletes,
  n_live_tup AS live_rows,
  n_dead_tup AS dead_rows
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
```

### Get Index Usage

```sql
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan AS scans,
  idx_tup_read AS tuples_read,
  idx_tup_fetch AS tuples_fetched
FROM pg_stat_user_indexes
ORDER BY idx_scan DESC;
```

### Get Database Size

```sql
SELECT
  pg_size_pretty(pg_database_size(current_database())) AS db_size,
  pg_database_size(current_database()) / (1024.0 * 1024.0 * 1024.0) AS size_gb;
```

### Get Table Sizes

```sql
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
  pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
  pg_size_pretty(pg_indexes_size(schemaname||'.'||tablename)) AS indexes_size
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

---

## Common Pitfalls

1. **Using wrong regional pricing**: Pricing varies significantly by region (DPU: $0.000008-$0.00001, Storage: $0.33-$0.45). Always query `awspricing` for the target region.
2. **Underestimating read TPS**: Read traffic is often 100-1000× write traffic
3. **Ignoring index overhead**: Indexes add ~40-60% to storage and write costs
4. **Forgetting compute costs**: Commit latency adds up at high TPS
5. **Not accounting for multi-region**: MR writes double write DPU costs
6. **Poor index design**: Missing indexes cause table scans and dramatically increase read DPU costs

---

## Agent Guidance: Common Estimation Mistakes

When helping customers with cost estimates, follow these best practices:

**DO:**

- Always state "This estimate assumes..." with key assumptions listed
- Call out the biggest cost driver and optimization opportunity
- Offer to refine estimates if customer provides schema/queries
- Mention that EXPLAIN ANALYZE gives more accurate estimates once cluster exists
- Compare to customer's current database costs if available
- Emphasize that these are rough estimates (+/- 30%) until real workload data is available

**Best Practice Flow:**

1. Query `awspricing` for region → Get current DPU + Storage prices
2. Collect workload metrics → TPS, data size, basic query patterns
3. Use Default DPU Values → Apply to workload metrics
4. Calculate and present → Show cost breakdown with largest driver highlighted
5. Suggest optimizations → Specific to their cost drivers (e.g., add indexes if read-heavy)
6. Set expectations → "EXPLAIN ANALYZE on real queries will provide more accurate results"

---

## References

- [Aurora DSQL Pricing](https://aws.amazon.com/rds/aurora/dsql-pricing/)
- [DSQL Performance Best Practices](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/performance.html)
- [DSQL Query Optimization](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/query-optimization.html)
