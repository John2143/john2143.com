use clap::Parser;

pub mod api;
pub mod database;

#[derive(clap::Parser, Clone)]
pub struct Config {
    #[clap(long, env)]
    pub mongo_db_connection: String,

    #[clap(long, env)]
    pub mongo_db_table: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    /*
    tracing_subscriber::fmt()
        //.with_max_level(tracing::Level::INFO)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .init();
    */

    let config = Config::parse();
    let db = database::setup_db(&config).await?;
    return api::setup(config, db.clone()).await;
}
