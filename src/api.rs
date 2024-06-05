use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};

use tracing::error;

use crate::database::MongoDriver;

#[derive(Clone)]
pub struct AppState {
    pub http_client: reqwest::Client,
    pub vars: Arc<crate::Config>,
    pub db: MongoDriver,
}

pub async fn setup(config: crate::Config, database: MongoDriver) -> anyhow::Result<()> {
    let state = AppState {
        vars: Arc::new(config),
        db: database,
        http_client: reqwest::Client::new(),
    };

    let app = Router::new()
        .route("/", get(root))
        .route("/healthz", get(health))
        .route("/readyz", get(ready))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
    tracing::info!("Server listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn root() -> &'static str {
    "Ok"
}

async fn health(State(AppState { .. }): State<AppState>) -> StatusCode {
    StatusCode::OK
}

async fn ready(State(AppState { .. }): State<AppState>) -> StatusCode {
    StatusCode::OK
}

// From axum docs:

// Make our own error that wraps `anyhow::Error`.
#[derive(Debug)]
pub(crate) struct AppError(anyhow::Error);

// Tell axum how to convert `AppError` into a response.
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Something went wrong: {}", self.0),
        )
            .into_response()
    }
}

// This enables using `?` on functions that return `Result<_, anyhow::Error>` to turn them into
// `Result<_, AppError>`.
impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        let e = err.into().context("API Endpoint Error");
        error!("An API encountered an error: {:?}", e);
        Self(e)
    }
}
