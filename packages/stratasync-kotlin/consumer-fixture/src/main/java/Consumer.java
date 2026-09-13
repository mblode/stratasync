import dev.stratasync.Wire;

public final class Consumer {
    public static void main(String[] args) {
        if (Wire.INSTANCE.compareIds("9007199254740993", "9007199254740992") != 1) {
            throw new AssertionError("Published SDK lost cursor precision");
        }
        System.out.println("Maven consumer passed");
    }
}
