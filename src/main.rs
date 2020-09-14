use actix_web::{web, App, HttpRequest, HttpServer, Responder};

async fn test(req: HttpRequest) -> impl Responder {
    format!("Hello World")

}

#[actix_rt::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .route("/", web::get().to(test))
    })
    .bind("0.0.0.0:8000")?
    .run()
    .await
}
