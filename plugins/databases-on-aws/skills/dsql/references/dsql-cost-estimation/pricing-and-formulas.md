# Aurora DSQL Pricing and Formulas

Technical reference for DSQL pricing components, cost calculation formulas, and default values. Load [workflow.md](workflow.md) for the agent-facing estimation workflow.

## Pricing Components

### DPU (Database Processing Unit) Pricing

- **Price per DPU**: Varies by AWS region (use `awspricing` MCP server for current rates)
- **DPU Types**:
  - **Compute DPUs**: Transaction processing and commit overhead
  - **Read DPUs**: SELECT query processing
  - **Write DPUs**: INSERT/UPDATE/DELETE operations
  - **Multi-Region Write DPUs**: Additional cost for multi-region writes

### Storage Pricing

- **Price per GB-month**: Varies by AWS region (use `awspricing` MCP server for current rates)

### Regional Pricing Reference

**IMPORTANT**: Always query the `awspricing` MCP server for current pricing. The table below is for reference only and may be outdated.

| Region                   | Region Code    | DPU Price (per DPU) | Storage (per GB-Month) |
| ------------------------ | -------------- | ------------------- | ---------------------- |
| US East (N. Virginia)    | us-east-1      | $0.0000080          | $0.33                  |
| US East (Ohio)           | us-east-2      | $0.0000080          | $0.33                  |
| US West (Oregon)         | us-west-2      | $0.0000080          | $0.33                  |
| EU (Frankfurt)           | eu-central-1   | $0.0000095          | $0.45                  |
| EU (Ireland)             | eu-west-1      | $0.0000095          | $0.36                  |
| EU (London)              | eu-west-2      | $0.0000095          | $0.45                  |
| EU (Paris)               | eu-west-3      | $0.0000095          | $0.45                  |
| Asia Pacific (Tokyo)     | ap-northeast-1 | $0.0000100          | $0.40                  |
| Asia Pacific (Seoul)     | ap-northeast-2 | $0.0000100          | $0.40                  |
| Asia Pacific (Osaka)     | ap-northeast-3 | $0.0000100          | $0.40                  |
| Asia Pacific (Sydney)    | ap-southeast-2 | $0.0000090          | $0.36                  |
| Asia Pacific (Melbourne) | ap-southeast-4 | $0.0000090          | $0.36                  |
| Canada (Central)         | ca-central-1   | $0.0000090          | $0.36                  |
| Canada West (Calgary)    | ca-west-1      | $0.0000090          | $0.36                  |

**Regional Pricing Ranges:**

- DPU Pricing: $0.000008 (US) to $0.00001 (AP Tokyo/Seoul/Osaka) per DPU
- Storage Pricing: $0.33 (US) to $0.45 (EU Frankfurt/London/Paris) per GB-Month

### Cost Factors

| Factor                | Unit      | Description                                       |
| --------------------- | --------- | ------------------------------------------------- |
| **Writer Factor**     | 0.14      | Percentage of compute time for write transactions |
| **Reader Factor**     | 0.86      | Percentage of compute time for read transactions  |
| **Write DPU Factor**  | 0.05      | DPU cost multiplier for write operations          |
| **Read DPU Factor**   | 0.00375   | DPU cost multiplier for read operations           |
| **Seconds per Month** | 2,626,560 | Conversion factor for monthly calculations        |

---

## Cost Estimation Formulas

### 1. Write Transaction Costs

**Write DPUs per Transaction:**

```
Write DPUs = (
  # Rows Changed × Avg Write Statement Size × Write DPU Factor +
  # Index Statements × Avg Index Statement Size × Write DPU Factor
) / 1000
```

**Read DPUs per Write Transaction** (for reading before writing):

```
Read DPUs = (Read Statements × Avg Read Size × Read DPU Factor) / 1000
```

**Compute DPUs per Write Transaction:**

```
Compute DPUs = Commit Latency (ms) × Writer Factor × 0.001
```

**Monthly Write Costs:**

```
Monthly Write DPUs = Write TPS × Seconds per Month × Write DPUs per Txn
Monthly Read DPUs (in Write) = Write TPS × Seconds per Month × Read DPUs per Txn
Monthly Compute DPUs = Write TPS × Seconds per Month × Compute DPUs per Txn

Write Cost = Monthly Write DPUs × Region DPU Price
Read Cost = Monthly Read DPUs × Region DPU Price
Compute Cost = Monthly Compute DPUs × Region DPU Price
```

### 2. Read Transaction Costs

**Read DPUs per Transaction:**

```
Read DPUs = (
  # Rows Scanned × Avg Row Size +
  # Secondary Index Lookups × Avg Index Lookup Size
) × Read DPU Factor / 1000
```

**Compute DPUs per Read Transaction:**

```
Compute DPUs = Commit Latency (ms) × Reader Factor × 0.001
```

**Monthly Read Costs:**

```
Monthly Read DPUs = Read TPS × Seconds per Month × Read DPUs per Txn
Monthly Compute DPUs = Read TPS × Seconds per Month × Compute DPUs per Txn

Read Cost = Monthly Read DPUs × Region DPU Price
Compute Cost = Monthly Compute DPUs × Region DPU Price
```

### 3. Storage Costs

**Total Cluster Size:**

```
Total Size (TB) = (Data Size per Partition + Index Size per Partition) × # Shards
Total Size (GB) = Total Size (TB) × 1024

Monthly Storage Cost = Total Size (GB) × Region Storage Price
```

**Estimating Data and Index Size:**

```
Data Size (GB) = (Total Rows × Avg Row Size) / (1024³)
Index Size (GB) = Data Size × (# Indexes / # Tables) × 1.66
  (1.66 factor accounts for index overhead observed in production)
```

### 4. Multi-Region Write Costs

**NOTE:** Multi-Region Write DPUs only apply to **multi-region clusters**. Single-region clusters do NOT incur this cost.

For multi-region clusters, writes are replicated across regions and incur additional DPU costs:

```
MR-Write DPUs = Write DPUs per Transaction (same as single-region)
Monthly MR-Write Cost = Monthly Write DPUs × Region DPU Price
```

---

### When to Use Formulas vs. Default Values

**Use the formulas above if:**

- Customer provides specific query characteristics (exact rows scanned, statement sizes, etc.)
- Customer has EXPLAIN ANALYZE output showing DPU consumption
- You need to model "what-if" scenarios with varying parameters

**Use Default DPU Values (section below) if:**

- Customer is in planning phase with no cluster
- Customer doesn't know query-level details yet
- You need a quick ballpark estimate

Default values are empirically derived from typical workloads - they represent the formulas already applied to common patterns.

---

## How to Query Current Pricing

### Using awspricing MCP Server

**ALWAYS query `awspricing` for current regional pricing before calculating costs.**

The Aurora DSQL service code is `AuroraDSQL`. Query for both DPU and Storage pricing:

**Query DPU Pricing:**

```
Service: AuroraDSQL
Filter: usagetype contains "DistributedProcessingUnits"
Filter: regionCode = <target-region>
Example: regionCode = "us-east-1"
```

**Query Storage Pricing:**

```
Service: AuroraDSQL
Filter: usagetype contains "Storage"
Filter: regionCode = <target-region>
Example: regionCode = "us-east-1"
```

**Expected Results:**

- DPU pricing returned as price per DPU (e.g., $0.000008)
- Storage pricing returned as price per GB-Month (e.g., $0.33)

---

## Default DPU Values for Estimation

When customers don't have access to a running DSQL cluster to measure actual DPU consumption with EXPLAIN ANALYZE, use these empirically-derived default values:

| Metric                                | Default Value | Basis                                                               |
| ------------------------------------- | ------------- | ------------------------------------------------------------------- |
| Write DPUs per Transaction            | 0.063         | Rough estimate: average write with 2 rows changed, 4 index updates  |
| Read DPUs per Transaction (in writes) | 0.00047       | Rough estimate: average of 2 read statements per write transaction  |
| Compute DPUs per Transaction (writes) | 0.026         | Estimate based on 26ms commit latency for average write transaction |
| Compute DPUs per Transaction (reads)  | 0.003         | Estimate based on 3ms commit latency for average read transaction   |

### When to Use These Defaults

**Use defaults when:**

- Customer is in pre-deployment planning phase (no cluster yet)
- Customer wants ballpark estimates without EXPLAIN ANALYZE
- Customer has similar workload characteristics (small-to-medium transactions, typical index density)

**Use measured values when:**

- Customer has a running DSQL cluster
- Customer can provide EXPLAIN ANALYZE output from their actual queries
- Customer has unusual workload patterns (very large transactions, complex queries, minimal indexes)

### Workload Assumptions Behind Defaults

These defaults assume typical OLTP workload patterns:

- **Write transactions:** 2 rows changed, 4 indexes updated, 2 read statements before writing
- **Read transactions:** 50 rows scanned per SELECT, 2 secondary index lookups
- **Commit latency:** 26ms for writes, 3ms for reads (based on observed p50 latencies)

For workloads significantly different from these patterns, adjust the defaults or collect actual measurements.

---

## Example: Read-Heavy OLTP Workload

**Note:** Always query `awspricing` for current regional rates. This example uses us-east-1 pricing.

### Scenario

- **Scale:** 25.5B rows, 81TB storage, 1.1M read TPS, 7.4K write TPS
- **Use case:** High-traffic multi-tenant SaaS application
- **Region:** us-east-1 (DPU: $0.000008, Storage: $0.33/GB-Month)

### Input Parameters

| Category           | Parameters                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| **Cluster**        | 11 shards, 438 tables, 1,765 indexes (4.03 avg per table)                                      |
| **Data**           | 25.5B rows, 116 bytes avg row size, 81.03TB total (2.77TB data + 4.60TB indexes per partition) |
| **Write Workload** | 7,457 TPS, 2 rows/txn, 4.03 index updates/txn, 26ms commit latency                             |
| **Read Workload**  | 1,117,083 TPS, 50 rows scanned/query, 2 index lookups/query, 3ms commit latency                |

### Monthly Cost Breakdown

| Cost Component | Monthly Cost | % of Total | Notes                  |
| -------------- | ------------ | ---------- | ---------------------- |
| Read DPUs      | $260,558     | 68%        | Dominant cost driver   |
| Compute DPUs   | $74,511      | 19%        | Transaction overhead   |
| Write DPUs     | $19,702      | 5%         | Includes MR-Write DPUs |
| Storage (81TB) | $27,382      | 7%         | Data + indexes         |
| **TOTAL**      | **$382,153** | **100%**   |                        |

**Key Insight:** Read DPUs dominate costs (68%). Adding indexes to reduce table scans could save significant costs with query optimizations.

### Regional Variance

Same workload in **eu-central-1** (DPU: $0.0000095, Storage: $0.45/GB-Month):

- **Total: $458,630/month** (+20% due to higher DPU and storage prices)
  - DPU costs: $421,291/month (+18.8%)
  - Storage: $37,339/month (+36.4%)

### Fleet-Wide Extrapolation

If this represents 1/3 of your fleet (3.1M read TPS, 64K write TPS total):

- **Extrapolated cost: ~$1.5M/month**

---

## References

- [Aurora DSQL Pricing](https://aws.amazon.com/rds/aurora/dsql-pricing/)
- [DSQL Performance Best Practices](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/performance.html)
- [DSQL Query Optimization](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/query-optimization.html)
