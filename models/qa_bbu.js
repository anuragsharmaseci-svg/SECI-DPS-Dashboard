module.exports = (sequelize, DataTypes) => {
  const QaBbu = sequelize.define(
    "qa_bbu",
    {
      bbu_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      qa_project_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: "qa_registered_project",
          key: "qa_project_id",
        },
      },
      bbu_sl_no: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      bbu_item_sl_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      item_category: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      name_equipment: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      uom: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      quantity: {
        type: DataTypes.FLOAT,
        allowNull: true,
      },
      unit_price: {
        type: DataTypes.FLOAT,
        allowNull: true,
      },
      basic_price: {
        type: DataTypes.FLOAT,
        allowNull: true,
      },
      gst: {
        type: DataTypes.FLOAT,
        allowNull: true,
      },
      gst_percent: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      total_value: {
        type: DataTypes.FLOAT,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      freezeTableName: true,
    }
  );
  return QaBbu;
};