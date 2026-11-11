"""M10: OpenTelemetry for one model revision. The gateway passes W3C `traceparent`, so the
predict span here is a child of the gateway's call: one trace from client to model.

Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set (the worker sets it when tracing is configured).
Request bodies are never recorded: only the route, status and timing (SEC-14).
"""

from __future__ import annotations

import os

from fastapi import FastAPI


def instrument(
    app: FastAPI, revision_id: str, model_version_id: str, exporter: object | None = None
) -> bool:
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return False
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": "modelops-model-server",
                "modelops.revision_id": revision_id,
                "modelops.model_version_id": model_version_id,
            }
        )
    )
    if exporter is None:
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    else:  # tests: synchronous, in memory
        from opentelemetry.sdk.trace.export import SimpleSpanProcessor

        provider.add_span_processor(SimpleSpanProcessor(exporter))  # type: ignore[arg-type]
    trace.set_tracer_provider(provider)
    FastAPIInstrumentor.instrument_app(
        app, tracer_provider=provider, excluded_urls="healthz,readyz,metadata"
    )
    return True
