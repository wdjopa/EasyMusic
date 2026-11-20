// Empêche une fenêtre de console supplémentaire sous Windows en version publiée. NE PAS SUPPRIMER !
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    enjoysing_lib::run()
}
