import ExpoModulesCore
import Foundation
import SwiftUI

public class ExpoBlueskyTranslateModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoBlueskyTranslate")
    View(ExpoBlueskyTranslateView.self) {
      Events("onClose")
      Prop("text") { (view: ExpoBlueskyTranslateView, text: String) in
        view.props.text = text
      }
      Prop("isPresented") { (view: ExpoBlueskyTranslateView, isPresented: Bool) in
        view.props.isPresented = isPresented
      }
    }
  }
}