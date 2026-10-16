//! Guardian daemon: holds one FROST share, verifies PCZTs, signs rounds 1 and 2.
fn main() {
    let _ = std::any::type_name::<zec_frost::redpallas::Signature>();
    println!("guardian scaffold OK");
}
