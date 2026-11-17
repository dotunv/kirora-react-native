#import <Foundation/Foundation.h>

// Hooks the Kirora iOS SDK into the app's push callbacks at launch, before JavaScript runs,
// so the tap that launched the app reaches it (React Native Firebase does the same). The
// work is in Swift (`KiroraSdkLaunch` in KiroraSdkModule.swift), found by name: Objective-C
// can't see the SDK's Swift-only wrapper interface, and Swift can't define +load.
@interface KiroraSdkLauncher : NSObject
@end

@implementation KiroraSdkLauncher

+ (void)load {
  Class launch = NSClassFromString(@"KiroraSdkLaunch");
  SEL install = NSSelectorFromString(@"install");
  if ([launch respondsToSelector:install]) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    [launch performSelector:install];
#pragma clang diagnostic pop
  }
}

@end
