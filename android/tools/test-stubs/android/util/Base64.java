package android.util;
/** JDK test adapter only; never included in the Android APK. */
public final class Base64 {
  public static final int NO_PADDING=1, NO_WRAP=2, URL_SAFE=8;
  public static byte[] decode(String text,int flags) { return ((flags&URL_SAFE)!=0?java.util.Base64.getUrlDecoder():java.util.Base64.getDecoder()).decode(text); }
  public static String encodeToString(byte[] bytes,int flags) {
    java.util.Base64.Encoder encoder=(flags&URL_SAFE)!=0?java.util.Base64.getUrlEncoder():java.util.Base64.getEncoder();
    if((flags&NO_PADDING)!=0)encoder=encoder.withoutPadding();
    return encoder.encodeToString(bytes);
  }
}
